import type { ModelView } from "../../../connections.ts"

/** One pass per projection; Array.find historically selected the first duplicate ID. */
export function indexModelViews(models: readonly ModelView[]): ReadonlyMap<string, ModelView> {
  const index = new Map<string, ModelView>()
  for (const model of models) {
    const id = model.id
    if (!index.has(id)) index.set(id, model)
  }
  return index
}
