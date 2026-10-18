import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ConnectionsSnapshot, ModelView, ProviderView } from "../../../connections.ts"
import type { TuiController } from "../../../controller.ts"
import { HOSTED_PROVIDER } from "../../../hosted.ts"
import { UptokeyBackend } from "./index.ts"
import { indexModelViews } from "./model-index.ts"

test("model index reads each ID once and preserves the first matching object, including duplicate and empty IDs", () => {
  let reads = 0
  const model = (id: string, contextWindow: number): ModelView => ({
    get id() { reads++; return id }, contextWindow, ownedBy: "synthetic", providers: [], available: true,
  })
  const first = model("duplicate", 8192), later = model("duplicate", 99999), empty = model("", 100)
  const models = [first, later, empty, ...Array.from({ length: 2000 }, (_, i) => model(`model-${i}`, i))]
  const index = indexModelViews(models)
  expect(reads).toBe(models.length)
  expect(index.get("duplicate")).toBe(first)
  expect(index.get("")).toBe(empty)
  expect(index.get("absent")).toBeUndefined()
  const prior = indexModelViews([first])
  expect(indexModelViews([later]).get("duplicate")).toBe(later)
  expect(prior.get("duplicate")).toBe(first)
})

function fixture() {
  let reads = 0
  const model = (id: string, contextWindow: number): ModelView => ({
    get id() { reads++; return id }, contextWindow, ownedBy: "synthetic", providers: [], available: true,
  })
  const models = Array.from({ length: 2000 }, (_, i) => model(`model-${i}`, i + 1000))
  models.push(model("model-0", 99999))
  const provider = (id: string, ids: string[], eligible = true): ProviderView => ({
    id, displayName: id, kind: "local", supportLevel: "native", configured: eligible, enabled: eligible,
    eligible, reason: eligible ? null : "not_configured", models: ids, defaultModel: null, health: "not_checked",
    capabilities: ["tools"], helpUrl: null, executable: true,
  })
  const snapshot: ConnectionsSnapshot = {
    providers: [
      { ...provider("first", ["model-1", "missing", "model-0", "model-1"]), defaultModel: "model-0" },
      provider("catalog", ["model-2", "model-0"], false),
      provider("empty", []),
      provider("last", models.slice(0, 2000).map((_, i) => `model-${i}`)),
    ],
    models, combos: [], observedAt: null,
  }
  const controller = Object.assign(new EventEmitter(), {
    start: async () => undefined,
    view: { connections: snapshot },
    hostedModels: [{ modelId: "free-code", label: "Free code", contextTokens: 32768, maxOutputTokens: 4096, toolCalls: true }],
    client: { fetchAuth: async (path: string) => {
      expect(path).toBe("/local/connections")
      return Response.json({ connections: [
        { providerId: "last", enabled: true, priority: 1, modelIds: ["model-0"], toolModels: ["model-0"] },
        { providerId: "last", enabled: true, priority: 2, modelIds: ["model-0"], imageInputModels: ["model-0"] },
        { providerId: "first", enabled: true, priority: 1, modelIds: ["model-1"], audioInputModels: ["model-1"], toolModels: ["model-1"] },
      ] })
    } },
    workspace: {},
  })
  const root = mkdtempSync(join(tmpdir(), "uptokey-provider-projection-"))
  const backend = new UptokeyBackend({ controller: controller as unknown as TuiController, cwd: root, home: root, state: root, config: root })
  const projectLegacy = (providers: ProviderView[]) => providers.map(provider => ({
    id: provider.id, name: provider.displayName, source: "api", env: [], options: {},
    models: Object.fromEntries(provider.models.map(id => [id, (backend as any).toModel(provider, id, snapshot.models.find(model => model.id === id))])),
  }))
  return { backend, snapshot, model, projectLegacy, reset: () => { reads = 0 }, reads: () => reads }
}

test("SDK provider projections share one linear model pass and retain legacy content, ordering, eligibility and capabilities", async () => {
  const f = fixture()
  try {
    await f.backend.whenReady()
    f.reset()
    const config = (await f.backend.client.config.providers()).data
    expect(f.reads()).toBe(f.snapshot.models.length)
    const eligible = f.snapshot.providers.filter(provider => provider.eligible && provider.models.length)
    f.reset()
    const legacyConnected = f.projectLegacy(eligible)
    const legacyReads = f.reads()
    expect(legacyReads).toBeGreaterThan(f.snapshot.models.length * 100)
    expect(config.providers.slice(0, -1)).toEqual(legacyConnected)
    expect(config.providers.map((provider: { id: string }) => provider.id)).toEqual(["first", "last", HOSTED_PROVIDER])
    expect(Object.keys(config.providers[0].models)).toEqual(["model-1", "missing", "model-0"])
    expect(config.providers[0].models["model-0"].limit.context).toBe(1000)
    expect(config.providers[0].models.missing.limit.context).toBe(0)
    expect(config.providers[0].models["model-1"].capabilities.input.audio).toBe(true)
    expect(config.providers[1].models["model-0"].capabilities.input.image).toBe(true)
    expect(config.providers[1].models["model-0"].capabilities.toolcall).toBe(false)
    expect(config.providers[1].models["model-1"].capabilities.toolcall).toBe(true)
    expect(config.providers.at(-1).models["free-code"].capabilities.toolcall).toBe(true)
    expect(config.default).toEqual({ first: "model-0", last: "model-0", [HOSTED_PROVIDER]: "free-code" })

    f.reset()
    const listed = (await f.backend.client.provider.list()).data
    expect(f.reads()).toBe(f.snapshot.models.length)
    expect(listed.all.slice(0, -1)).toEqual(f.projectLegacy(f.snapshot.providers))
    expect(listed.all.map((provider: { id: string }) => provider.id)).toEqual(["first", "catalog", "empty", "last", HOSTED_PROVIDER])
    expect(listed.connected).toEqual(["first", "last", HOSTED_PROVIDER])
    expect(listed.default).toEqual(config.default)

    // A same-array row replacement must be observed on the next pass; no global or snapshot cache survives it.
    f.snapshot.models[0] = f.model("model-0", 65536)
    f.reset()
    const updated = (await f.backend.client.provider.list()).data
    expect(f.reads()).toBe(f.snapshot.models.length)
    expect(updated.all[0].models["model-0"].limit.context).toBe(65536)
  } finally { f.backend.dispose() }
})

test("provider projection keeps an absent snapshot empty", async () => {
  const f = fixture()
  try {
    await f.backend.whenReady()
    ;(f.backend as any).options.controller.view.connections = undefined
    ;(f.backend as any).options.controller.hostedModels = []
    expect((await f.backend.client.config.providers()).data).toEqual({ providers: [], default: {} })
    expect((await f.backend.client.provider.list()).data).toEqual({ all: [], default: {}, connected: [] })
  } finally { f.backend.dispose() }
})
