/** Test-only adapter: import the unchanged product bundle; never ship fixture code in the npm artifact. */
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fixtureOptions } from "../../src/tui/frontend/uptokey/fixture-bootstrap.ts";

if (!process.env.UPTOKEY_FRONTEND_BUNDLE || !process.env.UPTOKEY_FIXTURE) throw new Error("packaged_fixture_configuration_missing");
const { main } = await import(pathToFileURL(join(resolve(process.env.UPTOKEY_FRONTEND_BUNDLE), "main.js")).href);
await main(await fixtureOptions());
process.exit(process.exitCode ?? 0);
