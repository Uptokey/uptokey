declare global {
  const UPTOKEY_TUI_VERSION: string
}
export const InstallationVersion = typeof UPTOKEY_TUI_VERSION === "string" ? UPTOKEY_TUI_VERSION : "3.0.0-dev"
export const InstallationChannel: string = "local"
export const InstallationLocal = true
