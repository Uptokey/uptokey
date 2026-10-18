import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo } from "solid-js"
import { tr } from "../../../../uptokey/tr.ts"
import { usageSummary } from "../../../../uptokey/usage-summary.ts"

const id = "internal:sidebar-context"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

const formatCost = (cost: { usd: number; partial: boolean; estimated: boolean }) =>
  `${cost.partial ? "≥ " : cost.estimated ? "~" : ""}${money.format(cost.usd)}`

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))
  const summary = createMemo(() =>
    usageSummary(msg(), (providerID, modelID) => props.api.state.provider.find((item) => item.id === providerID)?.models[modelID]?.limit.context || undefined),
  )

  return (
    <box>
      <text fg={theme().text}>
        <b>{tr("Context")}</b>
      </text>
      {(() => {
        const context = summary().context
        if (!context) return <text fg={theme().textMuted}>{tr("Context not reported")}</text>
        return (
          <>
            <text fg={theme().textMuted}>{context.estimated ? "~" : ""}{context.tokens.toLocaleString()} {tr("tokens")}</text>
            <text fg={theme().textMuted}>{context.percent === null ? tr("Model window unknown") : `${context.percent}${tr("% used")}`}</text>
          </>
        )
      })()}
      <text fg={theme().textMuted}>{summary().cost ? `${formatCost(summary().cost!)} ${tr("spent")}` : tr("Cost not reported")}</text>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
