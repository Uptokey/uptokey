import { expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { TuiController } from '../../../controller.ts'
import { UptokeyBackend } from './index.ts'
import { bootstrapLocationDataV2 } from '../../vendor/opencode-tui/context/data.tsx'

const ACTIVE = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const DATE = '2026-10-17T12:00:00.000Z'
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function fixture() {
  const records = new Map([ACTIVE, OTHER].map(id => [id, {
    schemaVersion: 1, id, workspaceId: '33333333-3333-4333-8333-333333333333',
    projectId: null, title: id === ACTIVE ? 'Original' : 'Other', createdAt: DATE, updatedAt: DATE,
    revision: 7, archivedAt: null, activeBranchId: 'main', storagePolicy: 'temporary',
    processingPolicy: 'local_only', cloudSyncOptIn: false,
  }]))
  const requests: Array<{ path: string; body: Record<string, unknown> }> = []
  const events: Array<{ type: string; properties: any }> = []
  const destination = { providerId: 'ollama' }
  let responseStatus = 200, transportFailure = false, compactCalls = 0
  let gate: ReturnType<typeof deferred<void>> | undefined
  let getGate: ReturnType<typeof deferred<void>> | undefined
  let writeStarted: (() => void) | undefined
  const state = {
    activeConversation: { id: ACTIVE, title: 'Original', updatedAt: DATE },
    messages: [] as Array<{ id: string; compaction?: { covered: number; throughMessageId: string } }>,
    conversations: [] as Array<{ id: string; title: string; updatedAt: string }>,
    selectedModel: 'local-code', turn: 'idle', storagePolicy: 'temporary', processingPolicy: 'local_only',
  }
  const view = { mode: 'build', autonomy: false, busy: null as string | null, approvals: [] as unknown[], binding: null,
    question: null as unknown, todos: [] as unknown[],
    skills: [{ name: 'review', description: 'Review code', origin: '.agents/skills/review/SKILL.md', content: 'Review instructions', id: 'review', resources: [], sha256: 'a'.repeat(64), bytes: 19 }],
  }
  const controller = Object.assign(new EventEmitter(), {
    start: async () => undefined,
    client: {
      getSelectedDestination: () => destination,
      fetchAuth: async () => { throw Error('fixture_network_disabled') },
      fetchRaw: async (path: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body))
        requests.push({ path, body }); writeStarted?.()
        await gate?.promise
        if (transportFailure) throw Error('tui_transport_unavailable')
        if (responseStatus !== 200) return Response.json({ error: 'declined' }, { status: responseStatus })
        const id = decodeURIComponent(path.split('/').at(-2)!)
        const record = records.get(id)!
        if (body.expectedRevision !== record.revision) return Response.json({ error: 'conversation_conflict' }, { status: 409 })
        const committed = { ...record, title: body.title, revision: record.revision + 1 }
        records.set(id, committed)
        return Response.json(committed)
      },
    },
    workspace: {}, store: { conversationRevision: 3 }, busy: false,
    state, view, features: { audio: { active: false } }, items: () => [],
    conversations: { getConversation: async (id: string) => { await getGate?.promise; return structuredClone(records.get(id)!) } },
    refreshConversationList: async () => { state.conversations = [...records.values()].map(row => ({ id: row.id, title: row.title, updatedAt: row.updatedAt })) },
    compact: async () => { compactCalls++; state.messages.push({ id: `summary-${compactCalls}`, compaction: { covered: 8, throughMessageId: 'u1' } }) },
  })
  const backend = new UptokeyBackend({ controller: controller as unknown as TuiController, cwd: '/project', home: '/home', state: '/state', config: '/config' })
  backend.subscribe(event => {
    if ('type' in event.payload) events.push({ type: event.payload.type, properties: 'properties' in event.payload ? event.payload.properties : undefined })
  })
  return {
    backend, controller, records, requests, events, destination,
    status: (value: number) => { responseStatus = value },
    failTransport: () => { transportFailure = true },
    holdWrite: () => { gate = deferred<void>(); return gate },
    holdRead: () => { getGate = deferred<void>(); return getGate },
    writeStarted: (fn: () => void) => { writeStarted = fn },
    compactCalls: () => compactCalls,
  }
}

test('SDK rename commits through the canonical CAS route before updating the session, preserving temporary retention', async () => {
  const f = fixture()
  try {
    const hold = f.holdWrite(), started = deferred<void>()
    f.writeStarted(() => started.resolve())
    const pending = f.backend.client.session.update({ sessionID: ACTIVE, title: '  A clear title 🧭  ' })
    await started.promise
    expect(f.controller.state.activeConversation.title).toBe('Original')
    expect(f.events.some(event => event.type === 'session.updated')).toBe(false)
    hold.resolve()
    const result = await pending
    expect(result.error).toBeUndefined()
    expect(result.data.title).toBe('A clear title 🧭')
    expect(f.requests).toEqual([{ path: `/v1/workspace/conversations/${ACTIVE}/update`, body: { expectedRevision: 7, title: 'A clear title 🧭' } }])
    expect(f.records.get(ACTIVE)!.storagePolicy).toBe('temporary')
    expect(f.records.get(ACTIVE)!.processingPolicy).toBe('local_only')
    expect(f.controller.state.activeConversation.title).toBe('A clear title 🧭')
  } finally { f.backend.dispose() }
})

test('opening the session list shows conversations created by another client of the same core', async () => {
  const f = fixture()
  try {
    const EXTERNAL = '44444444-4444-4444-8444-444444444444'
    f.records.set(EXTERNAL, { ...structuredClone(f.records.get(OTHER)!), id: EXTERNAL, title: 'Created on the web' })
    const result = await f.backend.client.session.list()
    expect(result.error).toBeUndefined()
    expect(result.data.some((session: { id: string; title: string }) => session.id === EXTERNAL && session.title === 'Created on the web')).toBe(true)
  } finally { f.backend.dispose() }
})

test('SDK rename for an inactive session never opens it or overwrites the active title', async () => {
  const f = fixture()
  try {
    f.controller.busy = true // A different session is working; its revision is not touched.
    const result = await f.backend.client.session.update({ sessionID: OTHER, title: 'Renamed other' })
    expect(result.data.id).toBe(OTHER)
    expect(f.records.get(OTHER)!.title).toBe('Renamed other')
    expect(f.controller.state.activeConversation).toEqual({ id: ACTIVE, title: 'Original', updatedAt: DATE })
    expect(f.controller.state.storagePolicy).toBe('temporary')
  } finally { f.backend.dispose() }
})

test('SDK rename rejects active work and navigation during its read before issuing a write', async () => {
  const f = fixture()
  try {
    f.controller.busy = true
    expect((await f.backend.client.session.update({ sessionID: ACTIVE, title: 'No' })).error.data.message).toBe('conversation_busy')
    expect(f.requests).toHaveLength(0)
    f.controller.busy = false
    const hold = f.holdRead()
    const pending = f.backend.client.session.update({ sessionID: ACTIVE, title: 'No' })
    await Bun.sleep(0)
    f.controller.state.activeConversation.id = OTHER
    f.controller.store.conversationRevision++
    hold.resolve()
    expect((await pending).error.data.message).toBe('context_changed')
    expect(f.requests).toHaveLength(0)
  } finally { f.backend.dispose() }
})

test('a failed or lost rename response is visible, leaves the title intact and is never automatically replayed', async () => {
  for (const status of [409, 403, 503, 0]) {
    const f = fixture()
    try {
      if (status) f.status(status); else f.failTransport()
      const result = await f.backend.client.session.update({ sessionID: ACTIVE, title: 'Unconfirmed' })
      expect(result.data).toBeUndefined()
      expect(result.error).toBeDefined()
      expect(f.requests).toHaveLength(1)
      expect(f.controller.state.activeConversation.title).toBe('Original')
      expect(f.events.some(event => event.type === 'tui.toast.show' && event.properties.variant === 'error')).toBe(true)
      expect(f.events.some(event => event.type === 'session.updated')).toBe(false)
    } finally { f.backend.dispose() }
  }
})

test('explicit SDK throwOnError rejects a rename conflict; malformed titles never reach the server', async () => {
  const f = fixture()
  try {
    for (const title of ['', ' ', '🧭'.repeat(161)]) expect((await f.backend.client.session.update({ sessionID: ACTIVE, title })).error).toBeDefined()
    expect(f.requests).toHaveLength(0)
    f.status(409)
    await expect(f.backend.client.session.update({ sessionID: ACTIVE, title: 'Conflict' }, { throwOnError: true })).rejects.toThrow('conversation_conflict')
    expect(f.requests).toHaveLength(1)
  } finally { f.backend.dispose() }
})

test('navigation during an acknowledged rename cannot apply its title to a different session', async () => {
  const f = fixture()
  try {
    const hold = f.holdWrite(), started = deferred<void>()
    f.writeStarted(() => started.resolve())
    const pending = f.backend.client.session.update({ sessionID: ACTIVE, title: 'Committed original' })
    await started.promise
    f.controller.state.activeConversation = { id: OTHER, title: 'Other', updatedAt: DATE }
    f.controller.store.conversationRevision++
    hold.resolve()
    expect((await pending).data.id).toBe(ACTIVE)
    expect(f.controller.state.activeConversation.title).toBe('Other')
    expect(f.records.get(ACTIVE)!.title).toBe('Committed original')
  } finally { f.backend.dispose() }
})

test('a successful HTTP status with a different identity or changed retention is not an acknowledged rename', async () => {
  for (const patch of [{ id: OTHER }, { storagePolicy: 'local' }]) {
    const f = fixture()
    try {
      f.controller.client.fetchRaw = async () => Response.json({ ...f.records.get(ACTIVE), title: 'Untrusted', revision: 8, ...patch })
      const result = await f.backend.client.session.update({ sessionID: ACTIVE, title: 'Untrusted' })
      expect(result.error).toBeDefined()
      expect(result.data).toBeUndefined()
      expect(f.controller.state.activeConversation.title).toBe('Original')
    } finally { f.backend.dispose() }
  }
})

test('SDK summarize invokes the real controller operation with its selected destination and confirms a new canonical summary', async () => {
  const f = fixture()
  try {
    const result = await f.backend.client.session.summarize({ sessionID: ACTIVE, providerID: 'ollama', modelID: 'local-code' })
    expect(result).toEqual({ data: true, error: undefined })
    expect(f.compactCalls()).toBe(1)
    expect(f.controller.state.storagePolicy).toBe('temporary')
    expect(f.controller.state.processingPolicy).toBe('local_only')
    expect(f.requests).toHaveLength(0)
  } finally { f.backend.dispose() }
})

test('SDK summarize never switches session/model or claims success when compaction is a no-op', async () => {
  const f = fixture()
  try {
    for (const params of [
      { sessionID: OTHER, providerID: 'ollama', modelID: 'local-code' },
      { sessionID: ACTIVE, providerID: 'other', modelID: 'local-code' },
      { sessionID: ACTIVE, providerID: 'ollama', modelID: 'other' },
    ]) expect((await f.backend.client.session.summarize(params)).error).toBeDefined()
    expect(f.compactCalls()).toBe(0)
    f.controller.compact = async () => undefined
    expect((await f.backend.client.session.summarize({ sessionID: ACTIVE, providerID: 'ollama', modelID: 'local-code' })).error.data.message).toBe('conversation_compaction_not_completed')
    expect(f.controller.state.activeConversation.id).toBe(ACTIVE)
  } finally { f.backend.dispose() }
})

test('SDK summarize rejects active approvals and a changed retention context while awaiting completion', async () => {
  const f = fixture()
  try {
    const params = { sessionID: ACTIVE, providerID: 'ollama', modelID: 'local-code' }
    f.controller.view.approvals.push({ id: 'pending' })
    expect((await f.backend.client.session.summarize(params)).error.data.message).toBe('conversation_busy')
    expect(f.compactCalls()).toBe(0)
    f.controller.view.approvals = []
    f.controller.compact = async () => { f.controller.state.processingPolicy = 'external_allowed' }
    expect((await f.backend.client.session.summarize(params)).error.data.message).toBe('context_changed')
  } finally { f.backend.dispose() }
})

test('SDK skills projects the discovered inventory without activation, execution or a second filesystem scan', async () => {
  const f = fixture()
  try {
    const result = await f.backend.client.app.skills({}, { throwOnError: true })
    expect(result.data).toEqual([{ name: 'review', description: 'Review code', location: '.agents/skills/review/SKILL.md', content: 'Review instructions' }])
    result.data[0].name = 'changed by a consumer'
    expect(f.controller.view.skills[0]!.name).toBe('review')
    f.controller.view.skills = []
    expect((await f.backend.client.app.skills({})).data).toEqual([])
    expect(f.requests).toHaveLength(0)
    expect(f.compactCalls()).toBe(0)
  } finally { f.backend.dispose() }
})

test('the prompt Skills action opens the canonical activation panel without fabricating a skill slash command or replacing the draft', async () => {
  const f = fixture()
  try {
    Object.assign(f.controller.view, { binding: { projectId: 'project', rootBindingId: 'root', rootPath: '/project' } })
    const result = await f.backend.client.session.command({ command: 'skills' })
    expect(result.error).toBeUndefined()
    expect(f.events.filter(event => event.type === 'uptokey.panel.open').map(event => event.properties)).toEqual([{ name: 'skills' }])
    expect(f.events.some(event => event.type === 'tui.prompt.append')).toBe(false)
    expect(f.requests).toHaveLength(0)
    expect(f.controller.state.storagePolicy).toBe('temporary')
  } finally { f.backend.dispose() }
})

test('the compatibility descriptor and configuration do not advertise public sharing or a V2 data service', async () => {
  const f = fixture()
  try {
    const capabilities = (await f.backend.client.experimental.capabilities.get()).data
    expect(capabilities).toEqual({ backgroundSubagents: false, uptokey: {
      schemaVersion: 1, sessionApi: 'canonical-v1', locationDataV2: false, publicSessionSharing: false, historyPaging: true,
    } })
    expect((await f.backend.client.config.get()).data.share).toBe('disabled')
    expect(f.requests).toHaveLength(0)
  } finally { f.backend.dispose() }
})

test('the real V2 bootstrap starts zero endpoint calls only for an explicit canonical no-V2 capability', async () => {
  const f = fixture()
  try {
    let refreshed = 0
    const tasks = () => Array.from({ length: 8 }, () => { refreshed++; return Promise.resolve('real upstream result') })
    expect(await bootstrapLocationDataV2(() => f.backend.client.experimental.capabilities.get(), tasks)).toEqual([])
    expect(refreshed).toBe(0)
    for (const data of [{}, { uptokey: { schemaVersion: 1, locationDataV2: true } }, { uptokey: { schemaVersion: 2, locationDataV2: false } }]) {
      const result = await bootstrapLocationDataV2(async () => ({ data }), tasks)
      expect(result).toHaveLength(8)
      expect(result.every(item => item.status === 'fulfilled')).toBe(true)
    }
    expect(refreshed).toBe(24)
  } finally { f.backend.dispose() }
})

test('the V2 bootstrap preserves upstream errors and does not start requests after the context is disposed', async () => {
  let refreshed = 0
  const tasks = () => [Promise.resolve('first'), Promise.reject(Error('upstream failed'))].map(task => { refreshed++; return task })
  const result = await bootstrapLocationDataV2(async () => { throw Error('unknown upstream capability API') }, tasks)
  expect(result.map(item => item.status)).toEqual(['fulfilled', 'rejected'])
  expect(refreshed).toBe(2)
  const pending = deferred<{ data: {} }>()
  let active = true
  const stopped = bootstrapLocationDataV2(() => pending.promise, tasks, () => active)
  active = false
  pending.resolve({ data: {} })
  expect(await stopped).toEqual([])
  expect(refreshed).toBe(2)
})

test('SDK revert and unrevert reach the canonical turn undo/redo and report a refusal as an error', async () => {
  const f = fixture()
  try {
    const calls: string[] = []
    let undoResult: { prompt: string } | null = { prompt: 'Fix it' }, redoResult = true
    Object.assign(f.controller, {
      undoTurn: async (id: string) => { calls.push(`undo:${id}`); return undoResult },
      redoTurn: async () => { calls.push('redo'); return redoResult },
    })
    const undone = await f.backend.client.session.revert({ sessionID: ACTIVE, messageID: 'msg_m-1' })
    expect(undone.error).toBeUndefined()
    expect(undone.data.id).toBe(ACTIVE)
    undoResult = null
    const refused = await f.backend.client.session.revert({ sessionID: ACTIVE, messageID: 'msg_m-2' })
    expect(refused.error).toBeDefined()
    const redone = await f.backend.client.session.unrevert({ sessionID: ACTIVE })
    expect(redone.error).toBeUndefined()
    redoResult = false
    expect((await f.backend.client.session.unrevert({ sessionID: ACTIVE })).error).toBeDefined()
    expect(calls).toEqual(['undo:m-1', 'undo:m-2', 'redo', 'redo'])
  } finally { f.backend.dispose() }
})

test('SDK history pages backwards by a stable cursor and the complete read returns every message', async () => {
  const f = fixture()
  try {
    const items = Array.from({ length: 7 }, (_, index) => index % 2 === 0
      ? { kind: 'user', id: `u${index}`, text: `question ${index}` }
      : { kind: 'assistant', id: `a${index}`, text: `answer ${index}` })
    Object.assign(f.controller, { items: () => items })
    const last = await f.backend.client.session.messages({ sessionID: ACTIVE, limit: 2 })
    expect(last.data.map((m: any) => m.info.id)).toEqual(['msg_a5', 'msg_u6'])
    expect(last.meta).toEqual({ before: last.data[0].info.id, more: true })
    const earlier = await f.backend.client.session.messages({ sessionID: ACTIVE, limit: 2, before: last.meta.before })
    expect(earlier.data.map((m: any) => m.info.id)).toEqual(['msg_a3', 'msg_u4'])
    expect(earlier.meta.more).toBe(true)
    const complete = await f.backend.client.session.history({ sessionID: ACTIVE })
    expect(complete.data).toHaveLength(7)
    expect((await f.backend.client.session.messages({ sessionID: ACTIVE, before: 'msg_missing' })).error).toBeDefined()
    expect((await f.backend.client.session.messages({ sessionID: OTHER, limit: 2 })).error).toBeDefined()
  } finally { f.backend.dispose() }
})

test('MCP status reports the governed filesystem server as it actually is', async () => {
  const f = fixture()
  try {
    let catalog: { available: boolean } | null = { available: true }
    Object.assign(f.controller.workspace, { getFilesystemCatalog: async () => catalog })
    expect((await f.backend.client.mcp.status()).data).toEqual({ filesystem: { status: 'connected' } })
    catalog = { available: false }
    expect((await f.backend.client.mcp.status()).data).toEqual({ filesystem: { status: 'disabled' } })
    catalog = null
    expect((await f.backend.client.mcp.status()).data).toEqual({})
  } finally { f.backend.dispose() }
})

test('questions and task lists reach the session through events; replies return to the controller', async () => {
  const f = fixture()
  try {
    const answered: unknown[] = [], rejected: string[] = []
    Object.assign(f.controller.view, { question: null, todos: [] })
    Object.assign(f.controller, {
      answerQuestion: (id: string, answers: unknown) => { answered.push([id, answers]); f.controller.view.question = null; return true },
      rejectQuestion: (id: string) => { rejected.push(id); return true },
    })
    const flush = () => new Promise(resolve => setTimeout(resolve, 5))
    f.controller.view.question = { id: 'question-1', questions: [{ question: 'Which?', header: 'Which', options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }] }
    f.controller.view.todos = [{ content: 'Read', status: 'in_progress', priority: 'medium' }]
    f.controller.emit('change'); await flush()
    expect(f.events.find(event => event.type === 'question.asked')?.properties.id).toBe('question-1')
    expect(f.events.find(event => event.type === 'todo.updated')?.properties.todos).toEqual([{ content: 'Read', status: 'in_progress', priority: 'medium' }])
    expect((await f.backend.client.session.todo({ sessionID: ACTIVE })).data).toHaveLength(1)
    expect((await f.backend.client.question.list()).data).toHaveLength(1)
    await f.backend.client.question.reply({ requestID: 'question-1', answers: [['B']] })
    f.controller.emit('change'); await flush()
    expect(answered).toEqual([['question-1', [['B']]]])
    expect(f.events.some(event => event.type === 'question.replied' && event.properties.requestID === 'question-1')).toBe(true)
    await f.backend.client.question.reject({ requestID: 'question-2' })
    expect(rejected).toEqual(['question-2'])
  } finally { f.backend.dispose() }
})
