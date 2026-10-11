/** Project runner settings of a profile. `scripts/setup-project-runner.mjs` records the prepared images and the
 * Podman connection in `<data dir>/project-runner.json`, so a service started by the TUI (without the activation
 * variables) still runs commands in the prepared containers. Environment variables keep precedence. No credential is
 * stored here: only image references (pinned by digest), the connection name and the rootful choice. */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface ProjectRunnerSettings { podmanPath?: string; podmanConnection?: string; nodeImage?: string; pythonImage?: string }

const IMAGE = /^[a-z0-9][a-z0-9._\/:-]{0,255}@sha256:[0-9a-f]{64}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function readProjectRunnerFile(directory: string): ProjectRunnerSettings & { allowRootful?: boolean } {
  let value: unknown;
  try { value = JSON.parse(readFileSync(join(directory, "project-runner.json"), "utf8")); }
  catch { return {}; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const out: ProjectRunnerSettings & { allowRootful?: boolean } = {};
  if (typeof record.nodeImage === "string" && IMAGE.test(record.nodeImage)) out.nodeImage = record.nodeImage;
  if (typeof record.pythonImage === "string" && IMAGE.test(record.pythonImage)) out.pythonImage = record.pythonImage;
  if (typeof record.podmanConnection === "string" && NAME.test(record.podmanConnection)) out.podmanConnection = record.podmanConnection;
  if (typeof record.podmanPath === "string" && record.podmanPath.length < 1024 && /podman(\.exe)?$/i.test(record.podmanPath)) out.podmanPath = record.podmanPath;
  if (record.allowRootful === true) out.allowRootful = true;
  return out;
}

/** Environment first, then the profile file. A rootful connection recorded by the setup is honoured only when the
 * environment does not say otherwise. */
export function projectRunnerSettings(env: NodeJS.ProcessEnv, directory: string): ProjectRunnerSettings {
  const file = readProjectRunnerFile(directory);
  if (file.allowRootful && env.UPTOKEY_RUNNER_ALLOW_ROOTFUL === undefined && !env.UPTOKEY_PODMAN_CONNECTION) env.UPTOKEY_RUNNER_ALLOW_ROOTFUL = "1";
  return {
    podmanPath: env.UPTOKEY_PODMAN_PATH ?? file.podmanPath,
    podmanConnection: env.UPTOKEY_PODMAN_CONNECTION ?? file.podmanConnection,
    nodeImage: env.UPTOKEY_RUNNER_NODE_IMAGE ?? file.nodeImage,
    pythonImage: env.UPTOKEY_RUNNER_PYTHON_IMAGE ?? file.pythonImage,
  };
}
