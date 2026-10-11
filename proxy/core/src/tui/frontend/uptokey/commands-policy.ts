/**
 * Slash commands registered by the vendored OpenCode interface. Uptokey owns the command registry (the same list the
 * palette, help and key map use), so an OpenCode command appears only when it is functional here and does not
 * duplicate an Uptokey command of the same purpose.
 */
const OPENCODE_SLASH_KEPT = new Set(["connect", "themes", "timeline", "timestamps", "thinking", "editor"])

export function opencodeSlashAllowed(name: string): boolean {
  return OPENCODE_SLASH_KEPT.has(name)
}
