// Uptokey shim for @opencode-ai/core/global: per-user state lives under ~/.uptokey/tui, never in OpenCode's XDG paths.
import { Context } from "effect"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const root = process.env.UPTOKEY_TUI_HOME ?? path.join(os.homedir(), ".uptokey", "tui")
const paths = {
  get home() {
    return os.homedir()
  },
  data: path.join(root, "data"),
  bin: path.join(root, "bin"),
  log: path.join(root, "log"),
  repos: path.join(root, "repos"),
  cache: path.join(root, "cache"),
  config: path.join(root, "config"),
  state: path.join(root, "state"),
  tmp: path.join(os.tmpdir(), "uptokey-tui"),
}

for (const dir of [paths.data, paths.config, paths.state, paths.log, paths.cache]) fs.mkdirSync(dir, { recursive: true })

export const Path = paths

export interface Interface {
  readonly home: string
  readonly data: string
  readonly cache: string
  readonly config: string
  readonly state: string
  readonly tmp: string
  readonly bin: string
  readonly log: string
  readonly repos: string
}

export class Service extends Context.Service<Service, Interface>()("@uptokey/Global") {}

export const Global = { Path: paths, Service }
