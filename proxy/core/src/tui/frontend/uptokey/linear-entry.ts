/** Native Node host for the accessible presentation of the same terminal frontend. */
import { linearMain, mainOptionsFromArgs } from "./bootstrap.ts"

await linearMain(mainOptionsFromArgs())
process.exit(process.exitCode ?? 0)
