import { createMemo, createSignal } from "solid-js"
import { useLocal } from "../context/local"
import { map, pipe, flatMap, entries, filter, sortBy, take } from "remeda"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { createDialogProviderOptions, DialogProvider } from "./dialog-provider"
import { DialogVariant } from "./dialog-variant"
import * as fuzzysort from "fuzzysort"
import { useConnected } from "./use-connected"
import { useSync } from "../context/sync"
import { tr } from "../../../uptokey/tr.ts"
import { isHostedFreeModel } from "../../../uptokey/model-funding.ts"
import { getBackend } from "../../../uptokey/backend/registry.ts"
import { useControllerTick } from "../../../uptokey/panels/use-controller.ts"
import { accountText } from "../../../../account-ui.ts"

export function DialogModel(props: { providerID?: string }) {
  const local = useLocal()
  const sync = useSync()
  const dialog = useDialog()
  const [query, setQuery] = createSignal("")
  const tick = useControllerTick()

  const connected = useConnected()
  const providers = createDialogProviderOptions()

  const showExtra = createMemo(() => connected() && !props.providerID)
  const accountAction = createMemo(() => {
    tick()
    const controller = getBackend().controller
    const session = controller.account.view.session
    if (props.providerID || session?.configured === false) return null
    if (!session?.authenticated || controller.hostedCatalogError === "account_reauthentication_required") return "account"
    return controller.hostedCatalogError ? "refresh" : null
  })

  const catalogOptions = createMemo(() => {
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
          filter(([_, info]) => (props.providerID ? info.providerID === props.providerID : true)),
          map(([model, info]) => ({
            value: { providerID: provider.id, modelID: model },
            title: info.name ?? model,
            releaseDate: info.release_date,
            description: favorites.some((item) => item.providerID === provider.id && item.modelID === model)
              ? "(Favorite)"
              : undefined,
            category: connected() ? provider.name : undefined,
            hostedFree: isHostedFreeModel(info),
            footer: isHostedFreeModel(info) ? accountText("free") : undefined,
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
        return [
          {
            key: item,
            value: { providerID: provider.id, modelID: model.id },
            title: model.name ?? item.modelID,
            description: provider.name,
            category,
            hostedFree: isHostedFreeModel(model),
            footer: isHostedFreeModel(model) ? accountText("free") : undefined,
            onSelect: () => {
              onSelect(provider.id, model.id)
            },
          },
        ]
      })
    }

    const favoriteOptions = toOptions(favorites, "Favorites")
    const recentOptions = toOptions(
      recents.filter(
        (item) => !favorites.some((fav) => fav.providerID === item.providerID && fav.modelID === item.modelID),
      ),
      "Recent",
    )

    const sectionModels = [...favorites, ...recents]
    const providerOptions = showSections
      ? catalogOptions().filter((option) => !sectionModels.some(
          (item) => item.providerID === option.value.providerID && item.modelID === option.value.modelID,
        ))
      : catalogOptions()

    const popularProviders = !connected()
      ? pipe(
          providers(),
          map((option) => ({
            ...option,
            category: tr("Popular providers"),
          })),
          take(6),
        )
      : []

    const accountOptions = accountAction() ? [{
      title: `${accountText(accountAction() === "refresh" ? "refresh" : "sign_in")} · ${accountText("free")}`,
      category: "Uptokey",
      value: { action: "account" as const },
      onSelect() {
        const backend = getBackend()
        if (accountAction() === "refresh") { void backend.controller.retryHostedModels(); return }
        backend.emit({ type: "uptokey.panel.open", properties: { name: "account" } })
      },
    }] : []

    if (needle) {
      return [
        ...fuzzysort.go(needle, accountOptions, { keys: ["title", "category"] }).map((x) => x.obj),
        ...sortModelOptions(
          fuzzysort.go(needle, providerOptions, { keys: ["title", "category"] }).map((x) => x.obj),
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
    if (!value) return "Select model"
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
          title: connected() ? "Connect provider" : "View all providers",
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
