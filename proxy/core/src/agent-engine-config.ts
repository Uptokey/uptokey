import { lstat, mkdir, mkdtemp, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";

export const OPENCODE_ENGINE_VERSION = "2.2.5" as const;
export const AGENT_ENGINE_INTERFACES = ["tui", "harness", "vscode", "chrome", "pwa"] as const;
export type AgentEngineInterface = typeof AGENT_ENGINE_INTERFACES[number];

export interface AgentEngineConfigInput {
  engineVersion: string;
  interface: AgentEngineInterface;
  inferenceUrl: string;
  model: string;
  declaredModels: readonly string[];
  mcpUrl: string;
  mcpTokenEnvironment?: string;
  /** Existing external directory. A fresh private child is created, never reused. */
  profileParent: string;
  /** Explicit host-owned empty root when the host only permits workspace writes.
   * Must resolve exactly to profileParent; never supplied by a model or project. */
  managedProfileRoot?: string;
  repositoryRoots: readonly string[];
  /** OS plumbing only is copied. Credentials must be bound by the launcher later. */
  environment?: NodeJS.ProcessEnv;
}

function localUrl(value: string, kind: "inference" | "mcp"): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`agent_engine_${kind}_url_invalid`); }
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname)
    || !url.port || url.username || url.password || url.search || url.hash
    || (kind === "inference" && !["/v1", "/v1/"].includes(url.pathname))) {
    throw new Error(`agent_engine_${kind}_url_invalid`);
  }
  return url.href.replace(/\/$/, "");
}

function within(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..`) && !isAbsolute(rel));
}

/**
 * Launch contract for the admitted Windows 2.2.5 binary, not an OS sandbox.
 * Its config.project switch disables ancestor config/plugin discovery; Windows
 * ProgramData is redirected as well because system config outranks inline config.
 * Unix system/managed config needs separate admission before enabling that host.
 * Launch ACP with cwd=session cwd=returned cwd and no extra ACP mcpServers.
 */
export async function createAgentEngineConfig(input: AgentEngineConfigInput) {
  if (process.platform !== "win32") throw new Error("agent_engine_host_not_admitted");
  if (input.engineVersion !== OPENCODE_ENGINE_VERSION) throw new Error("agent_engine_version_not_admitted");
  if (!AGENT_ENGINE_INTERFACES.includes(input.interface)) throw new Error("agent_engine_interface_invalid");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(input.model)
    || !input.declaredModels.includes(input.model)
    || ["__proto__", "constructor", "prototype"].includes(input.model)) throw new Error("agent_engine_model_not_declared");
  const inferenceUrl = localUrl(input.inferenceUrl, "inference");
  const mcpUrl = localUrl(input.mcpUrl, "mcp");
  const mcpTokenEnvironment = input.mcpTokenEnvironment ?? "UPTOKEY_TASK_TOKEN";
  if (!/^UPTOKEY_[A-Z][A-Z0-9_]{1,63}$/.test(mcpTokenEnvironment)
    || mcpTokenEnvironment === "UPTOKEY_ENGINE_TOKEN") throw new Error("agent_engine_mcp_token_reference_invalid");
  if (!isAbsolute(input.profileParent) || !input.repositoryRoots.length) throw new Error("agent_engine_profile_invalid");
  const parent = await realpath(input.profileParent);
  const managed = input.managedProfileRoot !== undefined;
  if (managed && (!isAbsolute(input.managedProfileRoot!) || await realpath(input.managedProfileRoot!) !== parent
    || (await readdir(parent)).length !== 0)) throw new Error("agent_engine_managed_profile_invalid");
  for (const root of input.repositoryRoots) {
    if (!isAbsolute(root)) throw new Error("agent_engine_repository_invalid");
    if (!managed && within(await realpath(root), parent)) throw new Error("agent_engine_profile_inside_repository");
  }
  // Also refuse unlisted Git working trees without reading any repository files.
  for (let cursor = parent; ; cursor = dirname(cursor)) {
    const git = await lstat(join(cursor, ".git")).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (git) throw new Error("agent_engine_profile_inside_repository");
    if (managed) break;
    if (dirname(cursor) === cursor) break;
  }
  const profile = await mkdtemp(join(parent, "uptokey-engine-"));
  const cwd = join(profile, "workspace");
  await Promise.all(["workspace", "tmp", "appdata", "localappdata", "programdata/opencode", "config/opencode", "data/opencode/log", "cache/opencode", "state/opencode"].map(path => mkdir(join(profile, path), { recursive: true })));
  const config = {
    model: `uptokey/${input.model}`, update: "disable", share: "disabled", snapshots: false,
    // This list is admitted only for the exact engine pin. Browser/worktree
    // tools live outside opencode.tool.*; permissions below independently deny
    // every action except this host's MCP namespace.
    plugins: ["-opencode.tool.*", "-opencode.tools", "-opencode.tools.*", "-opencode.browser"],
    // Code Mode is generated by core even with an empty catalog. Denying all
    // other actions removes execute as well as guarding any future native tool.
    permissions: [{ action: "*", resource: "*", effect: "deny" }, { action: "uptokey_*", resource: "*", effect: "ask" }],
    policies: [
      { action: "provider.use", resource: "*", effect: "deny" }, { action: "provider.use", resource: "uptokey", effect: "allow" },
      { action: "mcp.use", resource: "*", effect: "deny" }, { action: "mcp.use", resource: "uptokey", effect: "allow" },
    ],
    providers: { uptokey: {
      name: "Uptokey", env: ["UPTOKEY_ENGINE_TOKEN"],
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: inferenceUrl, apiKey: "{env:UPTOKEY_ENGINE_TOKEN}" },
      models: { [input.model]: { name: input.model, capabilities: { tools: true }, limit: { context: 32768, output: 2048 } } },
    } },
    mcp: { servers: { uptokey: {
      type: "remote", url: mcpUrl, oauth: false, codemode: false,
      headers: { Authorization: `Bearer {env:${mcpTokenEnvironment}}` },
    } } },
  };
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(input.environment ?? process.env)) {
    if (["systemroot", "windir", "path", "pathext", "comspec"].includes(name.toLowerCase())) env[name] = value;
  }
  Object.assign(env, {
    HOME: profile, USERPROFILE: profile, APPDATA: join(profile, "appdata"), LOCALAPPDATA: join(profile, "localappdata"),
    ProgramData: join(profile, "programdata"), ALLUSERSPROFILE: join(profile, "programdata"),
    TEMP: join(profile, "tmp"), TMP: join(profile, "tmp"),
    XDG_CONFIG_HOME: join(profile, "config"), XDG_DATA_HOME: join(profile, "data"),
    XDG_CACHE_HOME: join(profile, "cache"), XDG_STATE_HOME: join(profile, "state"),
    OPENCODE_CONFIG_DIR: join(profile, "config"), OPENCODE_TEST_HOME: profile,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_CONFIG_PROJECT_DISABLE: "true",
    OPENCODE_DISABLE_CLAUDE_CODE: "true", OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "true",
    OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_FILEWATCHER: "true",
  });
  return { engineVersion: OPENCODE_ENGINE_VERSION, interface: input.interface, profilePlacement: managed ? "managed" as const : "external" as const, profile, cwd, args: ["acp"], config, env,
    credentialEnvironment: { inference: "UPTOKEY_ENGINE_TOKEN", mcp: mcpTokenEnvironment } as const };
}
