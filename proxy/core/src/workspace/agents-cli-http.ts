/**
 * E2-14 HTTP/CLI seam — integrations / skills / install-plans / MCP discovery.
 * Shared http.ts can call handleAgentsCliHttp before route_not_found.
 * Additive only; does not fork chat/executor.
 */

import {
  doctorIntegrationSummary,
  integrationProfilesForUi,
  previewIntegrationCopy,
} from "../integration-profiles.ts";
import {
  loadInstalledManifest,
  previewSkillInstall,
  type SkillPackageFixture,
} from "../skill-install.ts";
import {
  createInstallPlan,
  type InstallPlan,
} from "../install-plan.ts";
import {
  DurablePlanRegistry,
} from "../durable-plan-registry.ts";
import {
  McpDiscoverySession,
  type McpToolDescriptor,
} from "../mcp-tool-binding.ts";
import {installOwnerPrefix} from './agents-cli-workspace.ts';

export type AgentsCliHttpResult = {
  status: number;
  body: Record<string, unknown>;
};

const PROJECT = "[A-Za-z0-9][A-Za-z0-9_-]{0,99}";
const PROFILE = "[A-Za-z0-9][A-Za-z0-9_-]{0,99}";
const PLAN = "[A-Za-z0-9][A-Za-z0-9_-]{0,99}";

/** Default durable plan registry — persists to state dir for reload survival. */
import { installPlansPath } from "../paths.ts";
let defaultPlanRegistry: DurablePlanRegistry | null = null;

function getDefaultPlanRegistry(): DurablePlanRegistry {
  if (!defaultPlanRegistry) defaultPlanRegistry = new DurablePlanRegistry(installPlansPath());
  return defaultPlanRegistry;
}

/** In-memory plan store interface for backward compatibility with tests. */
export interface PlanStore {
  get(planId: string): Promise<InstallPlan | undefined>;
  set(plan: InstallPlan): Promise<void>;
  clear(): Promise<void>;
}

export type AgentsCliHttpDeps = {
  principalId: string;
  /** Optional request headers (e.g. X-Abort). */
  headers?: Record<string, string | undefined>;
  /** Optional plan store; defaults to durable registry. */
  plans?: PlanStore;
  /** Optional resolver/validator for authorized project roots. */
  resolveAuthorizedRoot?: (principalId: string, projectId: string, targetRootRef: string) => Promise<string> | string;
  prepareSkillPlan?: (principalId:string,projectId:string,input:unknown)=>Promise<unknown>;
  prepareInstallPlan?: (principalId:string,projectId:string,input:unknown)=>Promise<unknown>;
};


export function agentsCliQueryAllowed(url: URL): boolean {
  const bare = url.pathname;
  if (bare === "/v1/workspace/integrations/capabilities" || bare === "/v1/workspace/integrations/profiles") {
    return url.search === "";
  }
  if (new RegExp(`^/v1/workspace/integrations/profiles/${PROFILE}/copy$`).test(bare)) {
    return [...url.searchParams.keys()].every((k) => ["baseUrl", "model", "token"].includes(k));
  }
  if (new RegExp(`^/v1/workspace/projects/${PROJECT}/skills/manifest$`).test(bare)) {
    return [...url.searchParams.keys()].every((k) => ["targetRootRef", "category", "source"].includes(k));
  }
  return false;
}

export function agentsCliMethod(path: string): "GET" | "POST" | undefined {
  const bare = path.split("?")[0] ?? path;
  if (bare === "/v1/workspace/integrations/capabilities") return "GET";
  if (bare === "/v1/workspace/integrations/profiles") return "GET";
  if (new RegExp(`^/v1/workspace/integrations/profiles/${PROFILE}/copy$`).test(bare)) return "GET";
  if (new RegExp(`^/v1/workspace/projects/${PROJECT}/skills/preview$`).test(bare)) return "POST";
  if (new RegExp(`^/v1/workspace/projects/${PROJECT}/skills/install$`).test(bare)) return "POST";
  if (new RegExp(`^/v1/workspace/projects/${PROJECT}/skills/manifest$`).test(bare)) return "GET";
  if (new RegExp(`^/v1/workspace/projects/${PROJECT}/install-plans$`).test(bare)) return "POST";
  if (new RegExp(`^/v1/workspace/projects/${PROJECT}/install-plans/${PLAN}/apply$`).test(bare)) return "POST";
  if (bare === "/v1/workspace/mcp/discovery/list") return "POST";
  return undefined;
}

/**
 * Dispatch a single agents-cli request. Returns null if path is not ours.
 * principalId must already be authenticated by the caller — never trust body.principalId.
 */
export async function handleAgentsCliHttp(
  method: string,
  pathname: string,
  input: unknown,
  deps: AgentsCliHttpDeps,
): Promise<AgentsCliHttpResult | null> {
  const bare = pathname.split("?")[0] ?? pathname;
  if (!agentsCliMethod(bare)) return null;

  const plans = deps.plans ?? getDefaultPlanRegistry();

  try {
    // GET /v1/workspace/integrations/capabilities
    if (method === "GET" && bare === "/v1/workspace/integrations/capabilities") {
      const doctor = doctorIntegrationSummary();
      return {
        status: 200,
        body: {
          id: "integrations",
          hash: "#integrations",
          ...doctor,
          copyGeneratesInstall: false,
          contractRevision: "e2-14.1",
        },
      };
    }

    // GET /v1/workspace/integrations/profiles
    if (method === "GET" && bare === "/v1/workspace/integrations/profiles") {
      return {
        status: 200,
        body: {
          profiles: integrationProfilesForUi(),
        },
      };
    }

    // GET /v1/workspace/integrations/profiles/:id/copy
    {
      const m = bare.match(new RegExp(`^/v1/workspace/integrations/profiles/(${PROFILE})/copy$`));
      if (method === "GET" && m) {
        const profileId = m[1]!;
        const q = asRecord(input);
        const baseUrl = typeof q.baseUrl === "string" ? q.baseUrl : undefined;
        const model = typeof q.model === "string" ? q.model : undefined;
        const token = typeof q.token === "string" ? q.token : undefined;
        const preview = previewIntegrationCopy(profileId, baseUrl, model, token);
        return {
          status: 200,
          body: {
            profile: preview.profile,
            contract: preview.contract as Record<string, unknown>,
            display: preview.display,
            copyGeneratesInstall: false,
          },
        };
      }
    }

    // Skills under project
    {
      const m = bare.match(new RegExp(`^/v1/workspace/projects/(${PROJECT})/skills/(preview|install|manifest)$`));
      if (m) {
        const projectId = m[1]!;
        const action = m[2]!;
        void projectId;
        if(method==='POST'&&action==='install'){
          if(!deps.prepareSkillPlan)return {status:503,body:{error:{type:'skill_governed_install_unavailable'}}};
          return {status:201,body:{view:await deps.prepareSkillPlan(deps.principalId,projectId,input)}};
        }

        if (method === "GET" && action === "manifest") {
          const q = asRecord(input);
          let targetRootRef = typeof q.targetRootRef === "string" ? q.targetRootRef : "";
          if (!targetRootRef) throw domainError("client_config_invalid");
          if (deps.resolveAuthorizedRoot) {
            targetRootRef = await deps.resolveAuthorizedRoot(deps.principalId, projectId, targetRootRef);
          }
          const manifest = await loadInstalledManifest(targetRootRef);
          return { status: 200, body: { manifest } };
        }

        if (method === "POST" && action === "preview") {
          const body = asRecord(input);
          let targetRootRef = typeof body.targetRootRef === "string" ? body.targetRootRef : "";
          if (!targetRootRef) throw domainError("client_config_invalid");
          if (deps.resolveAuthorizedRoot) {
            targetRootRef = await deps.resolveAuthorizedRoot(deps.principalId, projectId, targetRootRef);
          }
          const pkg = extractSkillPackage({ ...body, targetRootRef });
          const preview = await previewSkillInstall(targetRootRef, pkg);
          return { status: 200, body: { preview } };
        }
      }
    }

    // POST /v1/workspace/projects/:id/install-plans
    {
      const m = bare.match(new RegExp(`^/v1/workspace/projects/(${PROJECT})/install-plans$`));
      if (method === "POST" && m) {
        const projectId = m[1]!;
        void projectId;
        const body = asRecord(input);
        const targetRootRef = typeof body.targetRootRef === "string" ? body.targetRootRef : "";
        if (deps.resolveAuthorizedRoot && targetRootRef) {
          await deps.resolveAuthorizedRoot(deps.principalId, projectId, targetRootRef);
        }
        const files = extractFiles(body.files);
        const integrity =
          typeof body.integrity === "string" && body.integrity.length > 0 ? body.integrity : "auto";
        const plan = createInstallPlan({
          packageOrigin: typeof body.packageOrigin === "string" ? body.packageOrigin : "",
          exactVersion: typeof body.exactVersion === "string" ? body.exactVersion : "",
          integrity,
          targetRootRef,
          managerProfile: coerceManagerProfile(body.managerProfile),
          files,
        });
        plan.id=installOwnerPrefix(deps.principalId,projectId)+plan.id;
        await plans.set(plan);
        return { status: 201, body: { plan } };
      }
    }

    // POST /v1/workspace/projects/:id/install-plans/:planId/apply
    {
      const m = bare.match(
        new RegExp(`^/v1/workspace/projects/(${PROJECT})/install-plans/(${PLAN})/apply$`),
      );
      if (method === "POST" && m) {
        const projectId=m[1]!,planId=m[2]!;
        if(!planId.startsWith(installOwnerPrefix(deps.principalId,projectId)))return {status:403,body:{error:{type:'project_root_unauthorized'}}};
        const plan=await plans.get(planId);if(!plan)return {status:404,body:{error:{type:'install_plan_not_found'}}};
        if(!deps.prepareInstallPlan)return {status:503,body:{error:{type:'install_governed_install_unavailable'}}};
        const body=asRecord(input);
        return {status:201,body:{view:await deps.prepareInstallPlan(deps.principalId,projectId,{plan,files:extractFiles(body.files),expectedRevision:body.expectedRevision})}};
      }
    }

    // POST /v1/workspace/mcp/discovery/list — never executes tools
    if (method === "POST" && bare === "/v1/workspace/mcp/discovery/list") {
      const body = asRecord(input);
      if (!Array.isArray(body.tools)) throw domainError("mcp_output_invalid");
      const tools = body.tools as McpToolDescriptor[];
      const pageSize = typeof body.pageSize === "number" ? body.pageSize : 10;
      const cursor =
        body.cursor === null || body.cursor === undefined
          ? null
          : typeof body.cursor === "string"
            ? body.cursor
            : String(body.cursor);
      const session = new McpDiscoverySession(tools, pageSize);
      const page = session.list(cursor);
      return {
        status: 200,
        body: {
          tools: page.tools,
          nextCursor: page.nextCursor,
          callsExecuted: session.callsExecuted,
        },
      };
    }

    return { status: 404, body: { error: { type: "agents_cli_route_not_found" } } };
  } catch (err) {
    return mapDomainError(err);
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function domainError(code: string, reason?: string): Error {
  return Object.assign(new Error(code), { code, reason });
}

function headerValue(
  headers: Record<string, string | undefined> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

function extractSkillPackage(body: Record<string, unknown>): SkillPackageFixture {
  if (typeof body.id !== "string" || typeof body.revision !== "string") {
    throw domainError("client_config_invalid");
  }
  if (typeof body.license !== "string" || typeof body.sourceUrl !== "string") {
    throw domainError("client_config_invalid");
  }
  if (typeof body.entrypoint !== "string" || !Array.isArray(body.files)) {
    throw domainError("client_config_invalid");
  }
  return {
    id: body.id,
    revision: body.revision,
    license: body.license,
    sourceUrl: body.sourceUrl,
    entrypoint: body.entrypoint,
    files: extractFiles(body.files),
    dependencies: Array.isArray(body.dependencies)
      ? body.dependencies.filter((d): d is string => typeof d === "string")
      : undefined,
    allowedCapabilities: Array.isArray(body.allowedCapabilities)
      ? body.allowedCapabilities.filter((d): d is string => typeof d === "string")
      : undefined,
  };
}

function extractFiles(raw: unknown): Array<{ path: string; content: string }> {
  if (!Array.isArray(raw)) throw domainError("client_config_invalid");
  return raw.map((item) => {
    if (!item || typeof item !== "object") throw domainError("client_config_invalid");
    const rec = item as Record<string, unknown>;
    if (typeof rec.path !== "string" || typeof rec.content !== "string") {
      throw domainError("client_config_invalid");
    }
    return { path: rec.path, content: rec.content };
  });
}

function coerceManagerProfile(
  v: unknown,
): "npm" | "npx" | "pip" | "fixture" {
  if (v === "npm" || v === "npx" || v === "pip" || v === "fixture") return v;
  return "fixture";
}

function errorCodeOf(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const c = (err as { code?: unknown }).code;
    if (typeof c === "string" && c.length > 0) return c;
  }
  if (err instanceof Error && err.message) {
    // Some exclusive helpers throw plain Error(message) without .code
    const known = new Set([
      "integration_profile_unsupported",
      "client_config_invalid",
      "package_integrity_failed",
      "install_target_denied",
      "install_conflict",
      "mcp_schema_changed",
      "mcp_tool_unavailable",
      "mcp_output_invalid",
      "session_revoked",
      "tool_outcome_unknown",
    ]);
    if (known.has(err.message)) return err.message;
  }
  return undefined;
}

/**
 * Map known Error.code to HTTP status.
 * validation/integrity → 400; unsupported → 404; session_revoked → 409;
 * mcp_* → 400/409 as coherent.
 */
function mapDomainError(err: unknown): AgentsCliHttpResult {
  const code = errorCodeOf(err);
  if (!code) {
    return { status: 500, body: { error: { type: "agents_cli_internal" } } };
  }
  const status = statusForCode(code);
  const reason =
    err && typeof err === "object" && "reason" in err
      ? (err as { reason?: unknown }).reason
      : undefined;
  const body: Record<string, unknown> = { error: { type: code, code } };
  if (typeof reason === "string") {
    (body.error as Record<string, unknown>).reason = reason;
  }
  return { status, body };
}

function statusForCode(code: string): number {
  switch (code) {
    case "integration_profile_unsupported":
    case "project_missing":
      return 404;
    case "project_root_unauthorized":
      return 403;
    case "session_revoked":
    case "mcp_schema_changed":
      return 409;
    case "mcp_tool_unavailable":
      return 409;
    case "mcp_output_invalid":
    case "client_config_invalid":
    case "package_integrity_failed":
    case "install_target_denied":
    case "install_conflict":
    case "tool_outcome_unknown":
      return 400;
    default:
      if (code.startsWith("mcp_")) return 400;
      return 400;
  }
}

/** Test helper: clear default plan registry between cases. */
export async function resetAgentsCliPlanRegistry(): Promise<void> {
  if (defaultPlanRegistry) await defaultPlanRegistry.clear();
}
