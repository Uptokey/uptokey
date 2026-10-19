import { createMemo, createSignal } from "solid-js"
import { useLocal } from "../context/local"
import { map, pipe, flatMap, entries, filter, sortBy } from "remeda"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { DialogProvider } from "./dialog-provider"
import { DialogVariant } from "./dialog-variant"
import * as fuzzysort from "fuzzysort"
import { useConnected } from "./use-connected"
import { useSync } from "../context/sync"
import { tr } from "../../../uptokey/tr.ts"
import { isHostedFreeModel } from "../../../uptokey/model-funding.ts"
import { getBackend } from "../../../uptokey/backend/registry.ts"
import { useControllerTick } from "../../../uptokey/panels/use-controller.ts"
import { accountText } from "../../../../account-ui.ts"
import { ConnectProvider } from "../../../uptokey/dialogs/connect-provider.tsx"

export function DialogModel(props: { providerID?: string }) {
  const local = useLocal()
  const sync = useSync()
  const dialog = useDialog()
  const [query, setQuery] = createSignal("")
  const tick = useControllerTick()
  const accountAuthenticated = createMemo(() => { tick(); return getBackend().controller.account.view.session?.authenticated === true })

  const connected = useConnected()

  const showExtra = createMemo(() => connected() && !props.providerID)
  const accountAction = createMemo(() => {
    tick()
    const controller = getBackend().controller
    const session = controller.account.view.session
    if (props.providerID || session?.configured === false) return null
    if (!session?.authenticated || controller.hostedCatalogError === "account_reauthentication_required") return "account"
    if (controller.hostedCatalogError) return "refresh"
    return sync.data.provider.some(provider => Object.values(provider.models).some(isHostedFreeModel)) ? null : "account"
  })

  const catalogOptions = createMemo(() => {
    const authenticated = accountAuthenticated()
    const favorites = connected() ? local.model.favorite() : []
    return pipe(
      sync.data.provider,
      sortBy(
        (provider) => Object.values(provider.models).some(isHostedFreeModel),
        (provider) => provider.name,
      ),
      flatMap((provider) =>
        pipe(
          provider.models,
          entries(),
          filter(([_, info]) => info.status !== "deprecated"),
          filter(([_, info]) => !isHostedFreeModel(info) || authenticated),
          filter(([_, info]) => (props.providerID ? info.providerID === props.providerID : true)),
          map(([model, info]) => ({
            value: { providerID: provider.id, modelID: model },
            title: info.name ?? model,
            releaseDate: info.release_date,
            description: favorites.some((item) => item.providerID === provider.id && item.modelID === model)
              ? `(${tr("Favorite")})`
              : undefined,
            category: connected() ? provider.name : undefined,
            hostedFree: isHostedFreeModel(info),
            searchAliases: isHostedFreeModel(info) ? "Uptokey Free Plus" : undefined,
            // A Free model without declared tools answers in text only; the label says so before it is chosen.
            footer: isHostedFreeModel(info) ? accountText(info.capabilities?.toolcall ? "free" : "free_text_only") : undefined,
            onSelect() {
              onSelect(provider.id, model)
            },
          })),
          (options) => sortModelOptions(options, props.providerID !== undefined),
        ),
      ),
    )
  })

  const options = createMemo(() => {
    const needle = query().trim()
    const showSections = showExtra() && needle.length === 0
    const favorites = connected() ? local.model.favorite() : []
    const recents = local.model.recent()

    function toOptions(items: typeof favorites, category: string) {
      if (!showSections) return []
      return items.flatMap((item) => {
        const provider = sync.data.provider.find((provider) => provider.id === item.providerID)
        if (!provider) return []
        const model = provider.models[item.modelID]
        if (!model) return []
        if (isHostedFreeModel(model) && !accountAuthenticated()) return []
        return [
          {
            key: item,
            value: { providerID: provider.id, modelID: model.id },
            title: model.name ?? item.modelID,
            description: provider.name,
            category,
            hostedFree: isHostedFreeModel(model),
            footer: isHostedFreeModel(model) ? accountText(model.capabilities?.toolcall ? "free" : "free_text_only") : undefined,
            onSelect: () => {
              onSelect(provider.id, model.id)
            },
          },
        ]
      })
    }

    const favoriteOptions = toOptions(favorites, tr("Favorites"))
    const recentOptions = toOptions(
      recents.filter(
        (item) => !favorites.some((fav) => fav.providerID === item.providerID && fav.modelID === item.modelID),
      ),
      tr("Recent"),
    )

    const sectionModels = [...favorites, ...recents]
    const providerOptions = showSections
      ? catalogOptions().filter((option) => !sectionModels.some(
          (item) => item.providerID === option.value.providerID && item.modelID === option.value.modelID,
        ))
      : catalogOptions()

    const popularProviders = !connected()
      ? getBackend().providerChoices().filter((provider) => provider.executable).slice(0, 6).map((provider) => ({
          title: provider.label,
          value: provider.id,
          category: tr("Popular providers"),
          onSelect() { dialog.replace(() => <ConnectProvider providerId={provider.id} />) },
        }))
      : []

    const accountOptions = accountAction() ? [{
      title: `${accountText(accountAction() === "refresh" ? "refresh" : accountAuthenticated() ? "title" : "sign_in")} · ${accountText("free")}`,
      category: "Uptokey",
      searchAliases: "Uptokey Free Plus",
      value: { action: "account" as const },
      onSelect() {
        const backend = getBackend()
        if (accountAction() === "refresh") { void backend.controller.retryHostedModels(); return }
        backend.emit({ type: "uptokey.panel.open", properties: { name: "account" } })
      },
    }] : []

    if (needle) {
      return [
        ...fuzzysort.go(needle, accountOptions, { keys: ["title", "category", "searchAliases"] }).map((x) => x.obj),
        ...sortModelOptions(
          fuzzysort.go(needle, providerOptions, { keys: ["title", "category", "searchAliases"] }).map((x) => x.obj),
          false,
        ),
        ...fuzzysort.go(needle, popularProviders, { keys: ["title"] }).map((x) => x.obj),
      ]
    }

    const models = [...favoriteOptions, ...recentOptions, ...providerOptions]
    return [
      ...accountOptions,
      ...models.filter((option) => !option.hostedFree),
      ...models.filter((option) => option.hostedFree),
      ...popularProviders,
    ]
  })

  const provider = createMemo(() =>
    props.providerID ? sync.data.provider.find((item) => item.id === props.providerID) : null,
  )

  const title = createMemo(() => {
    const value = provider()
    if (!value) return tr("Select model")
    return value.name
  })

  function onSelect(providerID: string, modelID: string) {
    local.model.set({ providerID, modelID }, { recent: true })
    const list = local.model.variant.list()
    const cur = local.model.variant.selected()
    if (cur === "default" || (cur && list.includes(cur))) {
      dialog.clear()
      return
    }
    if (list.length > 0) {
      dialog.replace(() => <DialogVariant />)
      return
    }
    dialog.clear()
  }

  return (
    <DialogSelect<ReturnType<typeof options>[number]["value"]>
      virtualize={true}
      options={options()}
      actions={[
        {
          command: "model.dialog.provider",
          title: tr(connected() ? "Connect provider" : "View all providers"),
          selection: "none",
          onTrigger() {
            dialog.replace(() => <DialogProvider />)
          },
        },
        {
          command: "model.dialog.favorite",
          title: tr("Favorite"),
          hidden: !connected(),
          disabled: (option) => !option || typeof option.value !== "object" || !("modelID" in option.value),
          onTrigger: (option) => {
            local.model.toggleFavorite(option.value as { providerID: string; modelID: string })
          },
        },
      ]}
      onFilter={setQuery}
      flat={true}
      skipFilter={true}
      title={title()}
      current={local.model.current()}
    />
  )
}

export function sortModelOptions<T extends { hostedFree?: boolean; releaseDate: string | number; title: string }>(
  options: T[],
  newestFirst: boolean,
) {
  if (newestFirst) return sortBy(options, [(option) => option.releaseDate, "desc"], (option) => option.title)
  return sortBy(
    options,
    (option) => option.hostedFree === true,
    [(option) => option.releaseDate, "desc"],
    (option) => option.title,
  )
}
