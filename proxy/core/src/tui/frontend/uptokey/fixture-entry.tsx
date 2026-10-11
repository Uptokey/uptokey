/** Runs the production interface against the isolated journey fixture. */
import { main } from "./main.tsx"
import { fixtureOptions } from "./fixture-bootstrap.ts"

await main(await fixtureOptions())
process.exit(process.exitCode ?? 0)
