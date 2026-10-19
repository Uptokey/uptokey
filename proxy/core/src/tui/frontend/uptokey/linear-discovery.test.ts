import { expect, test } from "bun:test"
import { HOSTED_PROVIDER } from "../../hosted.ts"
import { linearModelChoices, loadLinearModelChoices } from "./linear.ts"

function fixture() {
  const ref = "acc_" + "a".repeat(64)
  return {
    view: { connections: { providers: [
      { id: "ollama", displayName: "Ollama", eligible: true, models: ["qwen-local"] },
      { id: "cloud-key", displayName: "My cloud account", eligible: true, models: ["my-connected-model"] },
      { id: "unconfigured", displayName: "Unconfigured", eligible: false, models: ["must-not-be-listed"] },
    ] } },
    account: { view: { session: { authenticated: true }, available: { currentAccountRef: ref, revision: 7 } } },
    hostedModels: [
      { accountRef: ref, revision: 7, modelId: "gemini-real-id", label: "Gemini from verified catalog" },
      { accountRef: ref, revision: 6, modelId: "stale-revision", label: "Stale revision" },
      { accountRef: "acc_" + "b".repeat(64), revision: 7, modelId: "other-account", label: "Other account" },
    ],
  }
}

test("linear models retain BYOK/local priority and search real hosted destinations by Uptokey/Free/Plus", () => {
  const controller = fixture()
  const all = linearModelChoices(controller as never)
  expect(all.map(row => row.id)).toEqual(["qwen-local", "my-connected-model", "gemini-real-id"])
  for (const query of ["uptokey", "Uptokey", "free", "plus", "Gemini"]) {
    const rows = linearModelChoices(controller as never, query)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({ provider: HOSTED_PROVIDER, id: "gemini-real-id", label: "Uptokey", name: "Gemini from verified catalog", hosted: true })
  }
  expect(linearModelChoices(controller as never, "qwen").map(row => row.id)).toEqual(["qwen-local"])
})

test("linear discovery removes hosted destinations on sign-out, missing account or revision change", () => {
  for (const state of ["signed-out", "missing-account", "new-revision", "different-account"] as const) {
    const controller = fixture()
    if (state === "signed-out") controller.account.view.session.authenticated = false
    if (state === "missing-account") controller.account.view.available.currentAccountRef = ""
    if (state === "new-revision") controller.account.view.available.revision = 99
    if (state === "different-account") controller.account.view.available.currentAccountRef = "acc_" + "c".repeat(64)
    expect(linearModelChoices(controller as never).filter(row => row.hosted)).toEqual([])
    expect(linearModelChoices(controller as never, "uptokey")).toEqual([])
    expect(linearModelChoices(controller as never).map(row => row.id)).toEqual(["qwen-local", "my-connected-model"])
  }
})

test("an empty verified hosted catalog never becomes an executable Uptokey placeholder", () => {
  const controller = fixture()
  controller.hostedModels = []
  const before = JSON.stringify(controller)
  expect(linearModelChoices(controller as never, "Uptokey")).toEqual([])
  expect(JSON.stringify(controller)).toBe(before)
})

test("opening the linear model menu uses valid cached inventory without refreshing or waiting for hosted networking", async () => {
  const controller = fixture()
  let refreshes = 0, hostedReads = 0
  const actual = Object.assign(controller, {
    async refreshConnections() { refreshes++; throw Error("cached_menu_must_not_refresh") },
    async refreshHostedModels() { hostedReads++; throw Error("menu_must_not_wait_for_hosted_network") },
  })
  expect((await loadLinearModelChoices(actual as never, "uptokey")).map(model => model.id)).toEqual(["gemini-real-id"])
  expect(refreshes).toBe(0)
  expect(hostedReads).toBe(0)
})

test("linear menu initializes missing inventory once and still rejects a stale hosted revision", async () => {
  const controller = fixture(), inventory = controller.view.connections
  Object.assign(controller.view, { connections: null })
  controller.account.view.available.revision = 99
  let refreshes = 0
  const actual = Object.assign(controller, { async refreshConnections() { refreshes++; controller.view.connections = inventory } })
  expect((await loadLinearModelChoices(actual as never)).map(model => model.id)).toEqual(["qwen-local", "my-connected-model"])
  expect(refreshes).toBe(1)
})
