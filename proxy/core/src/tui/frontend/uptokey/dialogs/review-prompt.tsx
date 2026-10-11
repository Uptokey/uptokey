/**
 * Decisions the person must take before an effect happens: reviewing a proposed change (files, hunks, diff) and
 * approving a plan-bound request. Replies are forwarded to the controller; nothing is executed from this component.
 */
import { createMemo, createSignal, For, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { useTheme } from "../../vendor/opencode-tui/context/theme"
import { useTuiConfig } from "../../vendor/opencode-tui/config"
import { getScrollAcceleration } from "../../vendor/opencode-tui/util/scroll"
import { filetype } from "../../vendor/opencode-tui/util/filetype"
import { OPENCODE_BASE_MODE, useBindings } from "../../vendor/opencode-tui/keymap"
import { Prompt } from "../../vendor/opencode-tui/routes/session/permission"
import type { ChangeFileView } from "../backend/permissions.ts"
import { getBackend } from "../backend/registry.ts"
import { ui } from "../i18n.ts"
import { JevLine } from "./jev-line.tsx"

function ChangeBody(props: { request: PermissionRequest }) {
  const { theme, syntax } = useTheme()
  const config = useTuiConfig()
  const dimensions = useTerminalDimensions()
  const backend = getBackend()
  const files = createMemo(() => (props.request.metadata.files as ChangeFileView[]) ?? [])
  const [cursor, setCursor] = createSignal({ file: 0, hunk: 0, hunks: false })
  const current = createMemo(() => files()[Math.min(cursor().file, Math.max(0, files().length - 1))])
  const view = createMemo(() => (config.diff_style === "stacked" ? "unified" : dimensions().width > 120 ? "split" : "unified"))

  useBindings(() => ({
    mode: OPENCODE_BASE_MODE,
    bindings: [
      {
        key: "up",
        desc: "Previous",
        group: "Review",
        cmd: () => setCursor((state) => (state.hunks ? { ...state, hunk: Math.max(0, state.hunk - 1) } : { file: Math.max(0, state.file - 1), hunk: 0, hunks: false })),
      },
      {
        key: "down",
        desc: "Next",
        group: "Review",
        cmd: () =>
          setCursor((state) =>
            state.hunks
              ? { ...state, hunk: Math.min((current()?.hunks.length ?? 1) - 1, state.hunk + 1) }
              : { file: Math.min(files().length - 1, state.file + 1), hunk: 0, hunks: false },
          ),
      },
      {
        key: "space",
        desc: "Toggle selection",
        group: "Review",
        cmd: () => (cursor().hunks ? backend.review.toggleHunk(cursor().file, cursor().hunk) : backend.review.toggleFile(cursor().file)),
      },
      {
        key: "s",
        desc: "Split into hunks",
        group: "Review",
        cmd: () => {
          if (backend.review.split(cursor().file)) setCursor({ file: cursor().file, hunk: 0, hunks: true })
        },
      },
    ],
  }))

  return (
    <box flexDirection="column" gap={1}>
      <For each={files()}>
        {(file, index) => (
          <box flexDirection="row" gap={1} paddingLeft={1}>
            <text fg={index() === cursor().file ? theme.primary : theme.textMuted}>{index() === cursor().file ? "›" : " "}</text>
            <text fg={file.selected ? theme.success : theme.textMuted}>{file.selected ? "[x]" : "[ ]"}</text>
            <text fg={theme.text}>{file.path}</text>
            <text fg={theme.diffHighlightAdded}>{`+${file.added}`}</text>
            <text fg={theme.diffHighlightRemoved}>{`-${file.removed}`}</text>
            <Show when={file.created}>
              <text fg={theme.textMuted}>{`(${ui("review_file_new")})`}</text>
            </Show>
          </box>
        )}
      </For>
      <box paddingLeft={1}>
        <JevLine request={props.request} />
      </box>
      <box flexDirection="row" gap={2} paddingLeft={1}>
        <text fg={theme.text}>
          {"↑↓"} <span style={{ fg: theme.textMuted }}>{ui("review_navigate")}</span>
        </text>
        <text fg={theme.text}>
          space <span style={{ fg: theme.textMuted }}>{ui("review_toggle")}</span>
        </text>
        <text fg={theme.text}>
          s <span style={{ fg: theme.textMuted }}>{ui("review_split")}</span>
        </text>
      </box>
      <Show when={current()?.hunks.length && cursor().hunks}>
        <box paddingLeft={4}>
          <For each={current()?.hunks ?? []}>
            {(hunk) => (
              <text fg={hunk.index === cursor().hunk ? theme.primary : theme.textMuted}>{`${hunk.selected ? "[x]" : "[ ]"} ${hunk.header}`}</text>
            )}
          </For>
        </box>
      </Show>
      <Show when={Number(props.request.metadata.failures) > 0}>
        <text fg={theme.warning}>{ui("review_conflicts", { count: Number(props.request.metadata.failures) })}</text>
      </Show>
      <Show when={current()?.diff}>
        <scrollbox height={12} scrollAcceleration={getScrollAcceleration(config)}>
          <diff
            diff={current()!.diff}
            view={view()}
            filetype={filetype(current()!.path)}
            syntaxStyle={syntax()}
            showLineNumbers={true}
            width="100%"
            wrapMode="word"
            fg={theme.text}
            addedBg={theme.diffAddedBg}
            removedBg={theme.diffRemovedBg}
            contextBg={theme.diffContextBg}
            addedSignColor={theme.diffHighlightAdded}
            removedSignColor={theme.diffHighlightRemoved}
            lineNumberFg={theme.diffLineNumber}
            lineNumberBg={theme.diffContextBg}
            addedLineNumberBg={theme.diffAddedLineNumberBg}
            removedLineNumberBg={theme.diffRemovedLineNumberBg}
          />
        </scrollbox>
      </Show>
    </box>
  )
}

function ConfirmBody(props: { request: PermissionRequest }) {
  const { theme } = useTheme()
  const config = useTuiConfig()
  return (
    <box flexDirection="column" gap={1} paddingLeft={1}>
      <text fg={theme.text}>{String(props.request.metadata.title ?? "")}</text>
      <scrollbox height={10} scrollAcceleration={getScrollAcceleration(config)}>
        <text fg={theme.textMuted}>{String(props.request.metadata.body ?? "")}</text>
      </scrollbox>
      <JevLine request={props.request} />
    </box>
  )
}

function ApprovalBody(props: { request: PermissionRequest }) {
  const { theme } = useTheme()
  const meta = () => props.request.metadata as Record<string, string | boolean>
  return (
    <box flexDirection="column" gap={1} paddingLeft={1}>
      <text fg={theme.text}>{String(meta().description ?? "")}</text>
      <Show when={meta().detail}>
        <text fg={theme.textMuted}>{String(meta().detail)}</text>
      </Show>
      <Show when={meta().args}>
        <text fg={theme.text}>{`$ ${meta().args}`}</text>
      </Show>
      <Show when={meta().path}>
        <text fg={theme.textMuted}>{String(meta().path)}</text>
      </Show>
      <Show when={meta().risk}>
        <text fg={meta().risk === "high" ? theme.error : meta().risk === "medium" ? theme.warning : theme.textMuted}>
          {`${ui("approval_risk")}: ${meta().riskBadge || meta().risk}${meta().riskSummary ? ` · ${meta().riskSummary}` : ""}`}
        </text>
      </Show>
      <Show when={meta().hasPlan === false}>
        <text fg={theme.warning}>{ui("approval_no_plan")}</text>
      </Show>
      <JevLine request={props.request} />
    </box>
  )
}

export function UptokeyPermission(props: { request: PermissionRequest }) {
  const backend = getBackend()
  const kind = () => props.request.permission
  return (
    <Show
      when={kind() === "uptokey_change"}
      fallback={
        <Prompt
          title={ui("approval_title")}
          body={kind() === "uptokey_confirm" ? <ConfirmBody request={props.request} /> : <ApprovalBody request={props.request} />}
          options={{ once: ui("approval_approve"), reject: ui("approval_decline") }}
          escapeKey="reject"
          onSelect={(option) => void backend.permissionReply(props.request.id, option === "once" ? "once" : "reject")}
        />
      }
    >
      <Prompt
        title={ui("review_title")}
        body={<ChangeBody request={props.request} />}
        options={{ once: ui("review_apply"), reject: ui("review_reject") }}
        escapeKey="reject"
        fullscreen
        onSelect={(option) => void backend.permissionReply(props.request.id, option === "once" ? "once" : "reject")}
      />
    </Show>
  )
}
