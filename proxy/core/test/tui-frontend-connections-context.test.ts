import test from "node:test"
import assert from "node:assert/strict"
import { prepareConnection, setupRecovery, setupErrorText, readUsageRows, CONNECTION_STRINGS, connectionText } from "../src/tui/frontend/uptokey/integration-connections.ts"
import { preparePromptParts, PromptPartsError, promptFilePath } from "../src/tui/frontend/uptokey/prompt-parts.ts"
import { ContextSet } from "../src/tui/context-set.ts"
import type { Lang } from "../src/tui/i18n.ts"
import { loadConnections } from "../src/tui/connections.ts"

test("connection inventory preserves observed profile revision and never invents one for an older daemon",async()=>{
  const connection={id:"11111111-1111-4111-8111-111111111111",providerId:"groq",label:"Fixture",enabled:true,eligible:true,models:["fixture"]};
  const client={fetchRaw:async(path:string)=>Response.json(path==="/v1/connections"?{providers:[],connections:[{...connection,revision:7},{...connection,id:"older"},{...connection,id:"invalid",revision:0}]}:{data:[]})};
  const snapshot=await loadConnections(client as never);
  assert.equal(snapshot.connections[0]?.revision,7);assert.equal(snapshot.connections[1]?.revision,undefined);assert.equal(snapshot.connections[2]?.revision,undefined);
});

const prepared = { providerId: "custom", label: "Custom", endpointUrl: "https://api.example.test/v1", models: [{ id: "my-model" }], usesSavedKey: true, dispose() {}, async commit() { return { providerId: "custom", modelId: "my-model", routingComboId: "tui-custom", reloaded: true as const } } }

test("saved key and endpoint survive a missing model catalog without another secret prompt", async () => {
  const calls: unknown[][] = []
  const result = await prepareConnection({
    choice: { id: "custom", local: false, configured: true },
    service: { async prepare(...args) { calls.push(args); throw new Error("provider_discovery_unsupported") }, async prepareManual(...args) { calls.push(args); return prepared } },
    requestKey: async () => { assert.fail("saved key should be reused") }, requestModel: async () => "my-model", requestEndpoint: async () => { assert.fail("saved endpoint should be reused") }, busy() {},
  })
  assert.equal(result, prepared)
  // The trailing argument is the dialog lifetime signal (absent here): discovery and manual setup are cancellable.
  assert.deepEqual(calls, [["custom", undefined, undefined, undefined], ["custom", undefined, undefined, "my-model", undefined]])
})

test("new valid key survives discovery fallback; network errors do not request a replacement", async () => {
  let secrets = 0
  const input = {
    choice: { id: "custom", local: false, configured: false }, endpoint: "https://api.example.test/v1",
    service: { async prepare() { throw new Error("provider_models_empty") }, async prepareManual(_id: string, key?: string) { assert.equal(key, "test-key"); return prepared } },
    requestKey: async () => { secrets++; return "test-key" }, requestModel: async () => "my-model", requestEndpoint: async () => null, busy() {},
  }
  assert.equal(await prepareConnection(input), prepared)
  assert.equal(secrets, 1)
  await assert.rejects(prepareConnection({ ...input, choice: { ...input.choice, configured: true }, service: { ...input.service, async prepare() { throw new Error("provider_discovery_failed") } } }), /provider_discovery_failed/)
  assert.equal(secrets, 1)
  assert.equal(setupRecovery(new Error("provider_key_rejected")), "key")
  assert.ok(!setupErrorText(new Error("provider body includes PRIVATE_KEY_TEST")).includes("PRIVATE_KEY_TEST"))
})

function controller(reader: (path: string) => Promise<any> = async () => ({ text: "project data", sha256: "a".repeat(64), byteLength: 12 })) {
  const context = new ContextSet()
  context.bind(reader, "root-1")
  return { context, view: { binding: { projectId: "project-1", rootBindingId: "root-1", rootPath: "C:\\work" } }, store: { conversationRevision: 1 }, state: { storagePolicy: "local", processingPolicy: "external_allowed" }, busy: false } as any
}

test("composer file selections enter verified context and persist only its references", async () => {
  const reads: string[] = []
  const ctl = controller(async path => { reads.push(path); return { text: "secret file content", sha256: "a".repeat(64), byteLength: 19 } })
  const result = await preparePromptParts(ctl, [{ type: "text", text: "Read this\nwith care" }, { type: "file", mime: "text/plain", url: "file:///C:/work/source/a.ts" }])
  assert.equal(result.text, "Read this\nwith care")
  assert.deepEqual(reads, ["source/a.ts"])
  const snapshot = await ctl.context.snapshotForDispatch()
  assert.deepEqual(snapshot.references.map((ref: any) => ref.relativePath), ["source/a.ts"])
  assert.ok(!JSON.stringify(snapshot.references).includes("secret file content"))
})

test("unsupported parts, foreign roots and busy sends are explicit refusals", async () => {
  const ctl = controller()
  await assert.rejects(preparePromptParts(ctl, [{ type: "text", text: "keep" }, { type: "file", mime: "image/png", url: "data:image/png;base64,YQ==" }]), error => error instanceof PromptPartsError && error.code === "attachment_unavailable")
  assert.equal(ctl.context.size, 0)
  assert.throws(() => promptFilePath({ type: "file", url: "file:///C:/other/a.ts" }, "C:\\work"), error => error instanceof PromptPartsError && error.code === "attachment_project")
  assert.throws(() => promptFilePath({ type: "file", url: "file:///C:/work/a.ts?start=3" }, "C:\\work"), error => error instanceof PromptPartsError && error.code === "attachment_unavailable")
  ctl.busy = true
  await assert.rejects(preparePromptParts(ctl, [{ type: "file", source: { path: "a.ts" } }]), error => error instanceof PromptPartsError && error.code === "attachment_busy")
})

test("file preparation cannot cross a conversation revision or leave partial context after failure", async () => {
  const ctl = controller(async path => path === "missing.ts" ? null : { text: "ok", sha256: "a".repeat(64), byteLength: 2 })
  await assert.rejects(preparePromptParts(ctl, [{ type: "file", source: { path: "a.ts" } }, { type: "file", source: { path: "missing.ts" } }]), error => error instanceof PromptPartsError && error.code === "attachment_read")
  assert.equal(ctl.context.size, 0)
  const changed = controller(async () => { changed.store.conversationRevision++; return { text: "ok", sha256: "a".repeat(64), byteLength: 2 } })
  await assert.rejects(preparePromptParts(changed, [{ type: "file", source: { path: "a.ts" } }]), error => error instanceof PromptPartsError && error.code === "attachment_changed")
  assert.equal(changed.context.size, 0)
})

test("editor ranges use authorized current text and persist only coordinates and file identity", async () => {
  let current = "private before\nconst marker = 42\nprivate after"
  const ctl = controller(async () => ({ text: current, sha256: "a".repeat(64), byteLength: Buffer.byteLength(current) }))
  const ranges = [{ text: "EDITOR_TEXT_MUST_NOT_BE_TRUSTED", selection: { start: { line: 1, character: 6 }, end: { line: 1, character: 12 } } }]
  const prepared = await preparePromptParts(ctl, [{ type: "text", text: "Explain it" }, { type: "text", synthetic: true, text: "EDITOR_TEXT_MUST_NOT_BE_TRUSTED", metadata: { kind: "editor_context", filePath: "C:\\work\\a.ts", ranges } }])
  assert.equal(prepared.text, "Explain it")
  const snapshot = await ctl.context.snapshotForDispatch()
  assert.ok(snapshot.block.includes("marker"))
  assert.ok(!/private before|private after|EDITOR_TEXT_MUST_NOT_BE_TRUSTED/.test(snapshot.block))
  assert.deepEqual(snapshot.references[0].ranges, ranges.map(range => range.selection))
  assert.ok(!JSON.stringify(snapshot.references).includes("marker"))
  current = "short"
  await assert.rejects(ctl.context.snapshotForDispatch(), /attachment_read/)
  assert.equal(ctl.context.entries()[0].state, "error")
  await assert.rejects(preparePromptParts(controller(), [{ type: "text", synthetic: true, metadata: { kind: "editor_context", filePath: "C:\\other\\a.ts", ranges } }]), error => error instanceof PromptPartsError && error.code === "attachment_project")
  await assert.rejects(preparePromptParts(controller(), [{ type: "text", synthetic: true, metadata: { kind: "editor_context", filePath: "a.ts", ranges: [{ start: { line: -1, character: 0 }, end: { line: 1, character: 0 } }] } }]), error => error instanceof PromptPartsError && error.code === "attachment_read")
})

test("usage never invents missing numeric values; every new message has ten translations", () => {
  assert.equal(readUsageRows({ providers: [] }), null)
  const metrics = { basis: "provider_reported", scope: "successful_router_responses_this_process", tokenTotals: "reported_subset_only", providers: [] }
  assert.deepEqual(readUsageRows(metrics), [])
  assert.equal(readUsageRows({ ...metrics, providers: [{ provider: "custom", totalTokens: 0 }] }), null)
  const langs: Lang[] = ["en", "pt-BR", "es", "fr", "de", "it", "ja", "ko", "zh-CN", "ar"]
  for (const [key, entry] of Object.entries(CONNECTION_STRINGS)) {
    assert.deepEqual(Object.keys(entry).sort(), [...langs].sort())
    for (const lang of langs) assert.ok(connectionText(key as keyof typeof CONNECTION_STRINGS, {}, lang).length > 0)
  }
})
