/**
 * Jev's reading of a decision that waits for approval: alignment with the person's request, chance of destroying
 * data, chance of reaching outside what was asked. It informs the person; approving still goes through the core.
 * When Jev cannot judge (no TypeSafe profile, local-only conversation, service failure) the line says why.
 */
import { createResource, Show } from "solid-js"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { useTheme } from "../../vendor/opencode-tui/context/theme"
import { getBackend } from "../backend/registry.ts"
import { ui } from "../i18n.ts"

function describe(request: PermissionRequest): { toolName: string; toolArgs: string; description?: string } {
  const meta = request.metadata as Record<string, unknown>
  if (request.permission === "uptokey_change") {
    const files = Array.isArray(meta.files) ? (meta.files as Array<{ path?: string; added?: number; removed?: number }>) : []
    return { toolName: "apply_file_changes", toolArgs: JSON.stringify(files.map((file) => ({ path: file.path, added: file.added, removed: file.removed }))), description: "Write the reviewed changes to the project files" }
  }
  if (request.permission === "uptokey_confirm") return { toolName: String(meta.title ?? "confirm"), toolArgs: String(meta.body ?? "") }
  return { toolName: String(meta.kind ?? meta.description ?? "run"), toolArgs: String(meta.args ?? meta.path ?? meta.detail ?? ""), ...(meta.description ? { description: String(meta.description) } : {}) }
}

export function JevLine(props: { request: PermissionRequest }) {
  const { theme } = useTheme()
  const backend = getBackend()
  const [judgment] = createResource(
    () => props.request.id,
    async () => {
      const result = await backend.judgeDecision(describe(props.request))
      const status = result.fallback ? await backend.jevStatus() : null
      return { result, reason: status?.reason ?? null }
    },
  )
  const percent = (value: number) => Math.round(value * 100)
  return (
    <Show when={judgment()} fallback={<text fg={theme.textMuted}>{ui("jev_judging")}</text>}>
      {(value) => (
        <Show
          when={!value().result.fallback}
          fallback={<text fg={theme.textMuted}>{ui("jev_unavailable", { reason: ui(`jev_reason_${value().reason ?? "request_failed"}`) })}</text>}
        >
          <text
            fg={
              value().result.destructiveRisk >= 0.65 || value().result.scopeViolationRisk >= 0.6 || value().result.alignmentScore < 0.4
                ? theme.warning
                : theme.textMuted
            }
          >
            {ui("jev_guard_line", {
              aligned: percent(value().result.alignmentScore),
              destructive: percent(value().result.destructiveRisk),
              scope: percent(value().result.scopeViolationRisk),
            })}
          </text>
        </Show>
      )}
    </Show>
  )
}
