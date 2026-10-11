import { randomUUID } from "node:crypto";
import type { TuiClient, TuiFunctionTool } from "./client.ts";
import type { ConversationService, NativeReadToolExecutor } from "./conversations.ts";
import { executeNativeApprovedPlan } from "./native-web-tools.ts";
import type { WorkspaceService } from "./workspace.ts";
import { t } from "./i18n.ts";
import {
  PersistentShell,
  terminateProcessTree,
  terminateProcessTreeAsync,
  closeAllHostSessions,
  closeHostSession,
  MAX_OUTPUT_BYTES,
  type CommandOutcome,
} from "../workspace/project-host-command.ts";

export { PersistentShell, terminateProcessTree, terminateProcessTreeAsync, MAX_OUTPUT_BYTES, type CommandOutcome };

export const SHADOW_BASH_TOOLS: TuiFunctionTool[] = [
  {
    type: "function",
    function: {
      name: "shadow_bash_run",
      description: "Run an interactive shell command on the host machine within the bound project root. Governed by W5 plan and user review, captures exit code and bounded UTF-8 output with authentic receipt recording.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to execute." },
          timeoutMs: { type: "integer", minimum: 1000, maximum: 300000, description: "Maximum command duration; defaults to 300000ms. Cancellation remains available." },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shadow_bash_close",
      description: "Terminate the persistent Shadow Bash session and free resources.",
      parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    },
  },
];

interface ActiveSessionEntry {
  shell: PersistentShell;
  ownerId?: string;
}

const activeSessions = new Map<string, ActiveSessionEntry>();

export function clearShadowBashSessions(ownerId: string) {
  const toDelete: string[] = [];
  for (const [key, session] of activeSessions.entries()) {
    if (session.ownerId === ownerId) {
      session.shell.terminate();
      toDelete.push(key);
    }
  }
  for (const key of toDelete) activeSessions.delete(key);
}

export function clearAllShadowBashSessions() {
  for (const session of activeSessions.values()) {
    session.shell.terminate();
  }
  activeSessions.clear();
  void closeAllHostSessions();
}

function getSessionKey(ownerId?: string, projectId?: string, rootBindingId?: string, conversationId?: string): string {
  return JSON.stringify([ownerId ?? "default", projectId ?? "local", rootBindingId ?? "default", conversationId ?? "default"]);
}

export interface ShadowBashExecutorOptions {
  workspace?: WorkspaceService;
  conversations?: ConversationService;
  projectId?: string;
  rootBindingId?: string;
  model?: string;
  sign?: (nonce: string) => string;
  ownerId?: string;
  cwd: string;
  stillBound?: () => boolean;
  confirm: (title: string, body: string, signal?: AbortSignal) => Promise<boolean>;
  client?: TuiClient;
  onStreamDelta?: (text: string) => void;
}

export function shadowBashExecutor(options: ShadowBashExecutorOptions): NativeReadToolExecutor {
  return async (call, signal, context) => {
    const sessionKey = getSessionKey(options.ownerId, options.projectId, options.rootBindingId, context?.conversationId);

    if (call.name === "shadow_bash_close") {
      signal?.throwIfAborted();
      if (context) await context.assertCurrent();
      if (options.stillBound && !options.stillBound()) throw new Error("project_binding_changed");
      if (options.workspace && options.projectId) {
        await options.workspace.closeHostCommandSession(options.projectId, {
          rootBindingId: options.rootBindingId,
          conversationId: context?.conversationId,
        });
      }
      const session = activeSessions.get(sessionKey);
      if (session) {
        await session.shell.close();
        activeSessions.delete(sessionKey);
      }
      return { output: JSON.stringify({ status: "closed" }), persistedOutput: { status: "closed" } };
    }

    if (call.name === "shadow_bash_run") {
      if (Object.keys(call.arguments).some(key => key !== 'command' && key !== 'timeoutMs')
        || typeof call.arguments.command !== 'string' || !call.arguments.command.trim()
        || call.arguments.command.length > 4000
        || (call.arguments.timeoutMs !== undefined && (!Number.isSafeInteger(call.arguments.timeoutMs)
          || Number(call.arguments.timeoutMs) < 1000 || Number(call.arguments.timeoutMs) > 300000))) {
        throw new Error('command_input_invalid');
      }
      const command = call.arguments.command;
      const timeoutMs = Number(call.arguments.timeoutMs ?? 300000);
      // A connected client must never silently fall through to a local effect
      // when admission dependencies or the conversation context are missing.
      if (options.workspace && (!options.sign || !options.projectId || !options.rootBindingId || !options.conversations || !context)) {
        throw new Error('conversation_admission_unavailable');
      }

      // ─── CANONICAL W5 FLOW ────────────────────────────────────────────────
      // When connected to the core with full workspace, sign and project bindings:
      // creates a signed ExecutionPlan, awaits UI consent & admission, and retrieves
      // an authentic ledger receipt.
      if (options.workspace && options.sign && options.projectId && options.rootBindingId && options.conversations) {
        signal?.throwIfAborted();
        if (options.stillBound && !options.stillBound()) throw new Error("project_binding_changed");
        if (context) await context.assertCurrent();

        const initial = await options.workspace.refresh(options.projectId, signal);
        signal?.throwIfAborted();
        if (options.stillBound && !options.stillBound()) throw new Error("project_binding_changed");
        if (context) await context.assertCurrent();

        const planned = await options.workspace.createHostCommandPlan(
          options.projectId,
          {
            expectedRevision: initial.revision,
            rootBindingId: options.rootBindingId,
            command,
            timeoutMs,
            conversationId: context?.conversationId,
          },
          signal
        );

        const summary = t("shadow_bash_confirm_body", { command });
        const settled = await executeNativeApprovedPlan(
          {
            workspace: options.workspace,
            conversations: options.conversations,
            projectId: options.projectId,
            model: options.model ?? "host",
            sign: options.sign,
            stillBound: options.stillBound ?? (() => true),
            confirm: options.confirm,
            client: options.client,
            onStreamDelta: options.onStreamDelta,
          },
          planned,
          summary,
          context!,
          signal
        );

        if (!settled) {
          const declined = { status: "declined" as const, reason: "user_declined", command };
          return { output: JSON.stringify(declined), persistedOutput: declined };
        }

        const runId = settled.run?.id;
        const receipt = settled.receipts.find(
          (r) => r.runId === runId && r.capabilityId === "workspace.project.host-command"
        );
        const artifactId = receipt?.outputArtifactRefs[0];

        let report: { exitCode?: number | null; stdout?: string; stderr?: string; output?: string; status?: string; error?: string } = {};
        if (artifactId) {
          try {
            const raw = await options.workspace.readArtifact(options.projectId, artifactId, signal);
            report = JSON.parse(raw);
          } catch (err) {
            report = {
              status: "failed",
              stdout: "",
              stderr: `artifact_read_failed: ${err instanceof Error ? err.message : String(err)}`,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }

        const exitCode = typeof report.exitCode === "number" ? report.exitCode : null;
        const status = report.status ?? (exitCode === 0 ? "completed" : "failed");
        const cleanOut = report.output ?? ([report.stdout, report.stderr].filter(Boolean).join("\n").trim());
        const metadata = {
          tool: call.name,
          status,
          command,
          exitCode,
          runId,
          ...(report.error ? { error: report.error } : {}),
          ...(receipt ? { receiptId: receipt.id } : {}),
          ...(artifactId ? { artifactId } : {}),
        };

        return {
          output: JSON.stringify({ ...metadata, output: cleanOut, stdout: report.stdout ?? '', stderr: report.stderr ?? '' }),
          persistedOutput: metadata,
          ...(receipt ? { receiptId: receipt.id } : {}),
        };
      }

      // ─── LOCAL PERSISTENT SHELL FLOW ──────────────────────────────────────
      // Used in standalone/test mode where core workspace is not configured:
      // executes locally with human confirmation and approved intention.
      signal?.throwIfAborted();
      if (options.stillBound && !options.stillBound()) throw new Error("project_binding_changed");
      if (context) await context.assertCurrent();

      const accepted = await options.confirm(
        t("shadow_bash_confirm_title"),
        t("shadow_bash_confirm_body", { command }),
        signal
      );

      signal?.throwIfAborted();
      if (options.stillBound && !options.stillBound()) throw new Error("project_binding_changed");
      if (context) await context.assertCurrent();

      if (!accepted) {
        const declined = { status: "declined" as const, reason: "user_declined", command };
        return { output: JSON.stringify(declined), persistedOutput: declined };
      }

      let intention: { messageId: string; requestId: string } | undefined;
      if (context?.appendApprovedIntention) {
        intention = await context.appendApprovedIntention(
          t("shadow_bash_approved_prompt", { command }),
          `tui_shadow_${randomUUID()}`
        );
      }

      let session = activeSessions.get(sessionKey);
      if (!session) {
        session = { shell: new PersistentShell(options.cwd), ownerId: options.ownerId };
        activeSessions.set(sessionKey, session);
      }

      const revalidate = async () => {
        signal?.throwIfAborted();
        if (options.stillBound && !options.stillBound()) throw new Error("project_binding_changed");
        if (context) await context.assertCurrent();
      };

      const result = await session.shell.runCommand(command, timeoutMs, signal, {
        onDelta: options.onStreamDelta,
        revalidate,
      });

      const metadata = {
        tool: call.name,
        status: result.status,
        command,
        exitCode: result.exitCode,
        ...(result.error ? { error: result.error } : {}),
        ...(intention ? { requestId: intention.requestId } : {}),
      };

      return {
        output: JSON.stringify({ ...metadata, output: result.output, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }),
        persistedOutput: metadata,
      };
    }

    throw new Error("tool_not_found");
  };
}
