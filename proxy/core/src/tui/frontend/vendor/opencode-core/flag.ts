// Uptokey shim for @opencode-ai/core/flag/flag: only the switches the vendored TUI reads.
export function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

export const Flag = {
  OPENCODE_DISABLE_AUTOUPDATE: true,
  OPENCODE_ALWAYS_NOTIFY_UPDATE: false,
  OPENCODE_DISABLE_TERMINAL_TITLE: truthy("UPTOKEY_TUI_DISABLE_TITLE"),
  OPENCODE_SHOW_TTFD: truthy("UPTOKEY_TUI_SHOW_TTFD"),
  OPENCODE_DISABLE_MOUSE: truthy("UPTOKEY_TUI_DISABLE_MOUSE"),
  OPENCODE_DISABLE_FFF: true,
  OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT: truthy("UPTOKEY_TUI_DISABLE_COPY_ON_SELECT"),
  OPENCODE_EXPERIMENTAL_WORKSPACES: false,
  OPENCODE_WORKSPACE_ID: undefined as string | undefined,
  OPENCODE_FAKE_VCS: undefined as string | undefined,
  OPENCODE_AUTO_HEAP_SNAPSHOT: false,
  OPENCODE_GIT_BASH_PATH: process.env["UPTOKEY_GIT_BASH_PATH"],
  OPENCODE_DISABLE_PRUNE: true,
  OPENCODE_DISABLE_AUTOCOMPACT: false,
  OPENCODE_DISABLE_MODELS_FETCH: true,
  OPENCODE_DISABLE_PROJECT_CONFIG: true,
  OPENCODE_EXPERIMENTAL_REFERENCES: false,
  OPENCODE_TUI_CONFIG: process.env["UPTOKEY_TUI_CONFIG"],
  OPENCODE_CONFIG_DIR: process.env["UPTOKEY_TUI_CONFIG_DIR"],
  OPENCODE_PURE: true,
  OPENCODE_PERMISSION: undefined as string | undefined,
  OPENCODE_PLUGIN_META_FILE: undefined as string | undefined,
  OPENCODE_CLIENT: "uptokey",
}
