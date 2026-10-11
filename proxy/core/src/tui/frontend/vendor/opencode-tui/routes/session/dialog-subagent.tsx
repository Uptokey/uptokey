import { DialogSelect } from "../../ui/dialog-select"
import { useRoute } from "../../context/route"
import { tr } from "../../../../uptokey/tr.ts"

export function DialogSubagent(props: { sessionID: string }) {
  const route = useRoute()

  return (
    <DialogSelect
      title={tr("Subagent Actions")}
      options={[
        {
          title: tr("Open"),
          value: "subagent.view",
          description: tr("the subagent's session"),
          onSelect: (dialog) => {
            route.navigate({
              type: "session",
              sessionID: props.sessionID,
            })
            dialog.clear()
          },
        },
      ]}
    />
  )
}
