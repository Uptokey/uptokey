import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

// Exercise the actual production submitInner body with controlled async owners.
// Terminal rendering/navigation is covered separately by the compiled PTY journey.
const source = readFileSync(new URL('../vendor/opencode-tui/component/prompt/index.tsx', import.meta.url), 'utf8')
const ast = ts.createSourceFile('prompt.tsx', source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX)
let body: ts.FunctionDeclaration | undefined
function visit(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'submitInner') body = node
  ts.forEachChild(node, visit)
}
visit(ast)
if (!body) throw Error('production_prompt_submit_missing')
const compiled = ts.transpileModule(body.getText(ast), {
  compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React },
}).outputText
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function fixture(text: string, mode = 'normal', sessionID: string | null = 'active') {
  const store: any = { prompt: { input: text, parts: [] }, mode, extmarkToPartIndex: new Map() }
  const calls = { detect: [] as string[], bind: [] as string[], command: [] as any[], shell: [] as any[], prompt: [] as any[], route: [] as any[], history: [] as any[], create: 0 }
  let detect = async (_text: string): Promise<string | undefined> => undefined
  let command = async (_params: any): Promise<unknown> => ({ data: true })
  let create = async (): Promise<unknown> => ({ data: { id: 'created' } })
  let confirm = false
  const input: any = { plainText: text, isDestroyed: false, extmarks: { getAllForTypeId: () => [], clear() {} }, clear() { input.plainText = '' } }
  const backend = { async detectFolder(value: string) { calls.detect.push(value); return detect(value) }, async bindFolder(value: string) { calls.bind.push(value); return true }, async judgeRequest() { return { confirm: false } } }
  const environment = {
    input, store, props: { sessionID }, promptRevision: 0,
    workspace: { clearNotice() {}, creating: () => false, selection: () => undefined },
    move: { creating: () => false, pending: () => false, progress: () => false, getDirectory: async () => undefined, startSubmit() {}, finishSubmit() {} },
    auto: () => undefined,
    local: { agent: { current: () => ({ name: 'build' }) }, model: { current: () => ({ providerID: 'fixture', modelID: 'coder' }), variant: { current: () => undefined } } },
    sync: { session: { get: () => ({}) }, data: { command: [{ name: 'projetos' }, { name: 'projects' }, { name: 'modelos' }] } },
    project: { workspace: { status: () => 'connected' } },
    sdk: { client: { session: {
      async command(params: any) { calls.command.push(params); return command(params) },
      async shell(params: any) { calls.shell.push(params); return { data: true } },
      async create() { calls.create++; return create() },
      async prompt(params: any) { calls.prompt.push(params); return { data: true } },
    } } },
    getBackend: () => backend,
    DialogConfirm: { show: async () => confirm }, dialog: { replace() {} }, ui: (key: string) => key,
    route: { navigate(value: unknown) { calls.route.push(value) } },
    expandTrackedPastedText: (value: string) => value, promptPartTypeId: 0, unwrap: (value: unknown) => value,
    editorContext: () => undefined, dismissEditorContext() {}, editor: {},
    history: { append(value: unknown) { calls.history.push(value) } },
    setStore(key: string, value: any) { store[key] = value },
    syncExtmarksWithPromptParts() {}, promptModelWarning() {}, exit() {},
    toast: { show() {} }, tr: (value: string) => value, errorMessage: (value: unknown) => String(value),
  }
  const api = new Function(...Object.keys(environment), `${compiled}; return { submit: submitInner, edit(text) { promptRevision++; input.plainText = text; store.prompt.input = text } };`)(...Object.values(environment)) as { submit(): Promise<boolean>; edit(text: string): void }
  return { api, calls, store, input, detect: (fn: typeof detect) => { detect = fn }, command: (fn: typeof command) => { command = fn }, create: (fn: typeof create) => { create = fn }, confirm: () => { confirm = true } }
}

test('a registered project command owns its absolute folder argument and clears once without folder prebinding', async () => {
  const h = fixture('/projetos /Users/user/project-b')
  h.detect(async () => '/Users/user/project-b'); h.confirm()
  expect(await h.api.submit()).toBe(true)
  expect(h.calls.detect).toEqual([])
  expect(h.calls.bind).toEqual([])
  expect(h.calls.command).toHaveLength(1)
  expect(h.calls.command[0]).toMatchObject({ command: 'projetos', arguments: '/Users/user/project-b' })
  expect(h.calls.route).toEqual([])
  expect(h.store.prompt.input).toBe('')
  expect(h.input.plainText).toBe('')
})

test('a delayed command result cannot clear a newer draft after its own command was dispatched', async () => {
  const h = fixture('/projects C:\\work\\project-b'), waiting = deferred<unknown>()
  h.command(() => waiting.promise)
  expect(await h.api.submit()).toBe(true)
  h.api.edit('New request in project B')
  waiting.resolve({ data: true }); await Promise.resolve(); await Promise.resolve()
  expect(h.store.prompt.input).toBe('New request in project B')
  expect(h.input.plainText).toBe('New request in project B')
  expect(h.calls.command).toHaveLength(1)
  expect(h.calls.history).toHaveLength(1)
})

test('an ordinary macOS absolute path still enters folder discovery and confirmed binding', async () => {
  const h = fixture('/Users/user/project-b')
  h.detect(async () => '/Users/user/project-b'); h.confirm()
  expect(await h.api.submit()).toBe(true)
  expect(h.calls.detect).toEqual(['/Users/user/project-b'])
  expect(h.calls.bind).toEqual(['/Users/user/project-b'])
  expect(h.calls.command).toEqual([])
  expect(h.calls.route[0]).toMatchObject({ type: 'home', prompt: { input: '/Users/user/project-b' } })
})

test('typing during ordinary folder discovery preserves the new draft and cancels the old continuation', async () => {
  const h = fixture('Use /Users/user/project-b'), waiting = deferred<string | undefined>()
  h.detect(() => waiting.promise)
  const pending = h.api.submit()
  h.api.edit('A newer request with its own context')
  waiting.resolve('/Users/user/project-b')
  expect(await pending).toBe(false)
  expect(h.store.prompt.input).toBe('A newer request with its own context')
  expect(h.input.plainText).toBe('A newer request with its own context')
  expect(h.calls.bind).toEqual([])
  expect(h.calls.command).toEqual([])
  expect(h.calls.prompt).toEqual([])
  expect(h.calls.route).toEqual([])
})

test('shell commands keep their own directory arguments and do not open the ordinary folder workflow', async () => {
  const h = fixture('ls /Users/user/project-b', 'shell')
  expect(await h.api.submit()).toBe(true)
  expect(h.calls.detect).toEqual([])
  expect(h.calls.bind).toEqual([])
  expect(h.calls.shell[0].command).toBe('ls /Users/user/project-b')
  expect(h.store.mode).toBe('normal')
})

test('a newer draft survives the asynchronous session creation response', async () => {
  const h = fixture('Original request', 'normal', null), waiting = deferred<unknown>()
  h.create(() => waiting.promise)
  const pending = h.api.submit()
  for (let i = 0; i < 100 && !h.calls.create; i++) await Promise.resolve()
  expect(h.calls.create).toBe(1)
  h.api.edit('New request typed during creation')
  waiting.resolve({ data: { id: 'created' } })
  expect(await pending).toBe(false)
  expect(h.store.prompt.input).toBe('New request typed during creation')
  expect(h.calls.prompt).toEqual([])
  expect(h.calls.route).toEqual([])
})
