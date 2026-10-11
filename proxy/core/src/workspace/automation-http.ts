/**
 * E2-13 HTTP/CLI seam — mountable without forking chat/executor.
 * Shared http.ts can call handleAutomationHttp before route_not_found.
 * Authorship: exclusive E2-13 surface; does not own workspace HTTP router.
 */

import type { AutomationService } from "./automation-service.ts";
import { AutomationError } from "./automation-types.ts";

export type AutomationHttpResult = {
  status: number;
  body: Record<string, unknown>;
};

const PROJECT = "[A-Za-z0-9][A-Za-z0-9_-]{0,99}";

/** Paths under /v1/workspace/... reserved for automations (additive). */
export function automationMethod(path: string, requestedMethod?:string): "GET" | "POST" | undefined {
  if (new RegExp(`^/v1/workspace/projects/${PROJECT}/automations(?:/.*)?$`).test(path)) {
    if (path.endsWith("/snapshot")) return "GET";
    if (/\/automations\/(?:presets|schedules|chains|outbox)$/.test(path)) return requestedMethod==='GET'?'GET':'POST';
    if (path.includes("/presets") && !path.includes("/revise") && path.match(/\/presets\/[^/]+$/)) return "GET";
    if (path.includes("/schedules") && path.match(/\/schedules\/[^/]+\/occurrences$/)) return "GET";
    if (path.includes("/chains") && path.match(/\/chains\/[^/]+$/) && !/\/chains\/(?:start|cancel|resolve)$/.test(path)) return "GET";
    if (/\/automations\/[^/]+$/.test(path) && !path.includes("/mini-chat") && !path.includes("/presets") && !path.includes("/schedules") && !path.includes("/outbox") && !path.includes("/approve") && !path.includes("/cancel") && !path.includes("/chains")) {
      return "GET";
    }
    return "POST";
  }
  if (path === "/v1/workspace/automations/capabilities") return "GET";
  return undefined;
}

export type AutomationHttpDeps = {
  service: AutomationService;
  principalId: string;
  assertProject?: (principalId:string,projectId:string)=>Promise<unknown>;
};

/**
 * Dispatch a single automations request. Returns null if path is not automations.
 * principalId must already be authenticated by the caller (workspace HTTP).
 */
export async function handleAutomationHttp(
  method: string,
  pathname: string,
  input: unknown,
  deps: AutomationHttpDeps,
): Promise<AutomationHttpResult | null> {
  const { service, principalId } = deps;
  if (pathname === "/v1/workspace/automations/capabilities" && method === "GET") {
    return {
      status: 200,
      body: {
        id: "automations",
        hash: "#automations",
        miniChat: true,
        presets: true,
        schedules: true,
        chains: !!service.chainExecutor,
        channels: ["brevo", "resend", "slack"],
        scheduledExecution: false,
        scheduledPreparation: true,
        externalDelivery: !!service.delivery,
        externalSendRequiresExplicitOutbox: true,
      },
    };
  }

  const m = pathname.match(new RegExp(`^/v1/workspace/projects/(${PROJECT})/automations(?:/(.*))?$`));
  if (!m) return null;
  const projectId = m[1]!;
  const rest = (m[2] ?? "").split("/").filter(Boolean);

  // ACL canônica: o dono da conversa/agenda é quem o servidor autenticou.
  const conversationRef = rest[0] && rest[0] !== "presets" && rest[0] !== "schedules" && rest[0] !== "outbox" ? rest[0] : undefined;
  const ownsConversation = conversationRef
    ? service.conversations.getConversation(conversationRef)?.principalId === principalId && service.conversations.getConversation(conversationRef)?.projectId === projectId
    : undefined;
  const scheduleRef = rest[0] === "schedules" && rest[1] && rest[1] !== "tick" ? rest[1] : undefined;
  const ownsSchedule = scheduleRef
    ? service.scheduler.getSchedule(scheduleRef)?.principalId === principalId && service.scheduler.getSchedule(scheduleRef)?.projectId === projectId
    : undefined;

  try {
    await deps.assertProject?.(principalId,projectId);
    if(method==='GET'&&rest.length===1&&rest[0]==='grants')return {status:200,body:{grants:service.grants.list(principalId,projectId)}};
    if(method==='POST'&&rest.length===3&&rest[0]==='grants'&&rest[2]==='revoke')return {status:200,body:{grant:service.grants.revoke(principalId,projectId,rest[1]!)}};
    if(method==='POST'&&rest.join('/')==='schedules/authorize'){
      if(!service.prepareScheduleGrant)throw new AutomationError('schedule_authorization_unavailable',503);
      return {status:200,body:await service.prepareScheduleGrant(principalId,projectId,input)};
    }
    if(method==='GET'&&rest.length===1&&rest[0]==='channels')return {status:200,body:{channels:service.delivery?await service.delivery.info(principalId,projectId):[],available:!!service.delivery}};
    if(method==='POST'&&rest.length===3&&rest[0]==='channels'&&['configure','disconnect'].includes(rest[2]!)){
      if(!service.delivery)throw new AutomationError('channel_delivery_unavailable',503);
      const channel=rest[2]==='configure'?await service.delivery.configure(principalId,projectId,rest[1],input):await service.delivery.disconnect(principalId,projectId,rest[1]);
      return {status:200,body:{channel}};
    }
    if(method==='POST'&&rest.join('/')==='outbox/plan'){
      if(!service.prepareChannel)throw new AutomationError('channel_delivery_unavailable',503);
      return {status:200,body:await service.prepareChannel(principalId,projectId,input)};
    }
    if(method==='GET'&&rest.length===1&&rest[0]==='presets')return {status:200,body:{presets:service.presets.list(principalId,projectId)}};
    if(method==='GET'&&rest.length===1&&rest[0]==='schedules')return {status:200,body:{schedules:service.scheduler.listSchedules(principalId,projectId)}};
    // POST .../automations  → open conversation
    if (method === "POST" && rest.length === 0) {
      const title = isRecord(input) && typeof input.title === "string" ? input.title : undefined;
      const conv = service.openAutomations(principalId, projectId, title);
      return { status: 201, body: { conversation: conv } };
    }

    // GET .../automations/:convId/snapshot
    if (method === "GET" && rest.length === 2 && rest[1] === "snapshot") {
      if (ownsConversation === false) throw new AutomationError("conversation_missing", 404);
      return { status: 200, body: service.conversations.uiSnapshot(rest[0]!) };
    }

    // POST .../automations/:convId/mini-chat
    if (method === "POST" && rest.length === 2 && rest[1] === "mini-chat") {
      if (ownsConversation === false) throw new AutomationError("conversation_missing", 404);
      const text = isRecord(input) && typeof input.text === "string" ? input.text : "";
      const turn = await service.miniChat(rest[0]!, text);
      return { status: 200, body: { turn } };
    }

    // POST .../automations/:convId/approve
    if (method === "POST" && rest.length === 2 && rest[1] === "approve") {
      if (ownsConversation === false) throw new AutomationError("conversation_missing", 404);
      const taskId = isRecord(input) && typeof input.taskId === "string" ? input.taskId : "";
      const done = await service.approveTask(principalId, rest[0]!, taskId);
      return { status: 200, body: done };
    }

    // POST .../automations/:convId/cancel
    if (method === "POST" && rest.length === 2 && rest[1] === "cancel") {
      if (ownsConversation === false) throw new AutomationError("conversation_missing", 404);
      const taskId = isRecord(input) && typeof input.taskId === "string" ? input.taskId : "";
      const task = await service.cancelTask(principalId, rest[0]!, taskId);
      return { status: 200, body: { task } };
    }

    // POST .../automations/presets
    if (method === "POST" && rest.length === 1 && rest[0] === "presets") {
      if (!isRecord(input) || typeof input.name !== "string" || !Array.isArray(input.steps)) {
        throw new AutomationError("invalid_request");
      }
      const preset = service.savePreset(principalId, projectId, {
        id: typeof input.id === "string" ? input.id : undefined,
        name: input.name,
        steps: input.steps as never,
        edges: Array.isArray(input.edges) ? (input.edges as never) : undefined,
      });
      return { status: 201, body: { preset } };
    }

    // POST .../automations/presets/:id/revise
    if (method === "POST" && rest.length === 3 && rest[0] === "presets" && rest[2] === "revise") {
      if (!isRecord(input) || !Array.isArray(input.steps)) throw new AutomationError("invalid_request");
      const preset = service.revisePreset(principalId, projectId, rest[1]!, {
        name: typeof input.name === "string" ? input.name : undefined,
        steps: input.steps as never,
        edges: Array.isArray(input.edges) ? (input.edges as never) : undefined,
      });
      return { status: 200, body: { preset } };
    }

    // GET .../automations/presets/:id
    if (method === "GET" && rest.length === 2 && rest[0] === "presets") {
      const preset = service.presets.get(principalId, projectId, rest[1]!);
      if (!preset) throw new AutomationError("preset_missing", 404);
      return { status: 200, body: { preset } };
    }

    // POST .../automations/schedules
    if (method === "POST" && rest.length === 1 && rest[0] === "schedules") {
      if (!isRecord(input)) throw new AutomationError("invalid_request");
      const schedule = service.schedulePreset(
        principalId,
        projectId,
        String(input.presetId ?? ""),
        Number(input.presetVersion ?? 0),
        input.kind === "cron_daily_minute" ? "cron_daily_minute" : "interval_ms",
        Number(input.value ?? 0),
      );
      return { status: 201, body: { schedule } };
    }

    // POST .../automations/schedules/tick
    if (method === "POST" && rest.length === 2 && rest[0] === "schedules" && rest[1] === "tick") {
      throw new AutomationError('scheduler_owned_by_runtime',403);
    }

    // GET .../automations/schedules/:id/occurrences
    if (method === "GET" && rest.length === 3 && rest[0] === "schedules" && rest[2] === "occurrences") {
      if (ownsSchedule === false) throw new AutomationError("schedule_missing", 404);
      return { status: 200, body: { occurrences: service.scheduler.listOccurrences(rest[1]!) } };
    }

    // POST .../automations/schedules/:id/enabled
    if (method === "POST" && rest.length === 3 && rest[0] === "schedules" && rest[2] === "enabled") {
      if (ownsSchedule === false) throw new AutomationError("schedule_missing", 404);
      if (!isRecord(input) || typeof input.enabled !== "boolean") throw new AutomationError("invalid_request");
      const schedule = service.setScheduleEnabled(principalId, rest[1]!, input.enabled);
      return { status: 200, body: { schedule } };
    }

    // POST .../automations/schedules/:id/revoke
    if (method === "POST" && rest.length === 3 && rest[0] === "schedules" && rest[2] === "revoke") {
      if (ownsSchedule === false) throw new AutomationError("schedule_missing", 404);
      const schedule = service.revokeSchedule(principalId, rest[1]!);
      return { status: 200, body: { schedule } };
    }

    // POST .../automations/chains/start
    if (method === "POST" && rest.length === 2 && rest[0] === "chains" && rest[1] === "start") {
      if (!isRecord(input)) throw new AutomationError("invalid_request");
      const chain = service.startChain(
        principalId,
        projectId,
        String(input.presetId ?? ""),
        Number(input.presetVersion ?? 0),
        typeof input.requestId === "string" ? input.requestId : undefined,
        input.input,
      );
      return { status: 201, body: { chain } };
    }

    // GET .../automations/chains
    if (method === "GET" && rest.length === 1 && rest[0] === "chains") {
      return { status: 200, body: { chains: service.listChains(principalId, projectId) } };
    }

    // GET .../automations/chains/:id
    if (method === "GET" && rest.length === 2 && rest[0] === "chains") {
      const chain = service.getChain(principalId, projectId, rest[1]!);
      if (!chain) throw new AutomationError("chain_missing", 404);
      return { status: 200, body: { chain } };
    }

    // POST .../automations/chains/:id/cancel
    if (method === "POST" && rest.length === 3 && rest[0] === "chains" && rest[2] === "cancel") {
      const chain = await service.cancelChain(principalId, projectId, rest[1]!);
      return { status: 200, body: { chain } };
    }

    // POST .../automations/chains/:id/resolve
    if (method === "POST" && rest.length === 3 && rest[0] === "chains" && rest[2] === "resolve") {
      if (!isRecord(input) || (input.action !== "keep_stopped" && input.action !== "retry")) throw new AutomationError("invalid_request");
      const chain = await service.resolveChain(principalId, projectId, rest[1]!, input.action as never);
      return { status: 200, body: { chain } };
    }

    // POST .../automations/outbox/preview
    if (method === "POST" && rest.length === 2 && rest[0] === "outbox" && rest[1] === "preview") {
      if (!isRecord(input) || typeof input.channel !== "string" || !isRecord(input.message)) {
        throw new AutomationError("invalid_request");
      }
      const record = await service.previewChannel(input.channel as never, input.message as never,{principalId,projectId});
      return { status: 200, body: { record } };
    }

    // POST .../automations/outbox/send-synthetic
    if (method === "POST" && rest.length === 2 && rest[0] === "outbox" && rest[1] === "send-synthetic") {
      if (!isRecord(input) || typeof input.channel !== "string" || !isRecord(input.message)) {
        throw new AutomationError("invalid_request");
      }
      const record = await service.sendChannelSynthetic(input.channel as never, input.message as never,{principalId,projectId});
      return { status: 200, body: { record } };
    }

    // GET .../automations/outbox
    if (method === "GET" && rest.length === 1 && rest[0] === "outbox") {
      return { status: 200, body: { records: service.outbox.list().filter(record=>record.principalId===principalId&&record.projectId===projectId) } };
    }

    return { status: 404, body: { error: { type: "automation_route_not_found" } } };
  } catch (err) {
    if (err instanceof Error && (err.message === 'workspace_project_not_found' || (err as NodeJS.ErrnoException).code === 'ENOENT')) {
      return { status: 404, body: { error: { type: 'workspace_not_found' } } };
    }
    if (err instanceof AutomationError) {
      return { status: err.status, body: { error: { type: err.code } } };
    }
    return { status: 500, body: { error: { type: "automation_internal" } } };
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** CLI-friendly thin adapter — same service, no parallel executor. */
export async function automationCli(
  service: AutomationService,
  argv: string[],
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const [cmd, ...args] = argv;
  try {
    if (cmd === "open") {
      return { ok: true, data: service.openAutomations(args[0] ?? "prin", args[1] ?? "proj", args[2]) };
    }
    if (cmd === "chat") {
      return { ok: true, data: await service.miniChat(args[0]!, args.slice(1).join(" ")) };
    }
    if (cmd === "presets") {
      return { ok: true, data: service.presets.list(args[0] ?? "prin", args[1] ?? "proj") };
    }
    if (cmd === "outbox") {
      return { ok: true, data: service.outbox.list() };
    }
    if (cmd === "chains") {
      return { ok: true, data: service.listChains(args[0] ?? "prin", args[1] ?? "proj") };
    }
    if (cmd === "tick") {
      return { ok: true, data: await service.runScheduler() };
    }
    return { ok: false, error: "usage: open|chat|presets|outbox|chains|tick" };
  } catch (err) {
    return { ok: false, error: err instanceof AutomationError ? err.code : "cli_failed" };
  }
}
