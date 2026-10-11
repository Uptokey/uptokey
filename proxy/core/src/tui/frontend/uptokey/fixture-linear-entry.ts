/** Isolated journey entry for the native Node accessible presentation. */
import { linearMain } from "./bootstrap.ts"
import { fixtureOptions } from "./fixture-bootstrap.ts"

await linearMain(await fixtureOptions())
process.exit(process.exitCode ?? 0)
