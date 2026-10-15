/** Native Node host for the accessible presentation of the same terminal frontend. */
import { linearMain, mainOptionsFromArgs } from "./bootstrap.ts"

try { await linearMain(mainOptionsFromArgs()) }
catch (error) {
  if (!(error instanceof Error) || error.name !== "AbortError") throw error
  process.exitCode = 130
}
process.exit(process.exitCode ?? 0)
