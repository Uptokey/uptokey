/** Diagnostic: what the project runner reports with the settings of a profile (no project is touched).
 *   node --experimental-strip-types scripts/probe-runner-profile.ts <data-dir> */
import { projectRunnerSettings } from "../src/workspace/runner-settings.ts";
import { ProjectOciBackend } from "../src/workspace/project-oci.ts";

const directory = process.argv[2];
if (!directory) throw new Error("usage: probe-runner-profile.ts <data-dir>");
const env = { ...process.env };
delete env.UPTOKEY_PODMAN_CONNECTION; delete env.UPTOKEY_RUNNER_NODE_IMAGE; delete env.UPTOKEY_RUNNER_PYTHON_IMAGE; delete env.UPTOKEY_RUNNER_ALLOW_ROOTFUL;
const settings = projectRunnerSettings(env, directory);
if (env.UPTOKEY_RUNNER_ALLOW_ROOTFUL) process.env.UPTOKEY_RUNNER_ALLOW_ROOTFUL = env.UPTOKEY_RUNNER_ALLOW_ROOTFUL;
console.log("settings", JSON.stringify(settings));
const backend = new ProjectOciBackend(settings as never);
for (const image of [settings.nodeImage, settings.pythonImage]) console.log(image?.split("@")[0], JSON.stringify(await backend.probe(image as never)));
