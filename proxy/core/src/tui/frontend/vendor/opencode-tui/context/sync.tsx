import { traceBoot } from "../../../uptokey/boot-trace.ts"
import type {
  Message,
  Agent,
  Provider,
  Session,
  Part,
  Config,
  Todo,
  Command,
  PermissionRequest,
  QuestionRequest,
  LspStatus,
  McpStatus,
  McpResource,
  FormatterStatus,
  SessionStatus,
  ProviderListResponse,
  ProviderAuthMethod,
  VcsInfo,
  SnapshotFileDiff,
  ConsoleState,
} from "@opencode-ai/sdk/v2"
import { createStore, produce, reconcile } from "solid-js/store"
import { useProject } from "./project"
import { useEvent } from "./event"
import { useSDK } from "./sdk"
import { useTuiStartup } from "./runtime"
import { createSimpleContext } from "./helper"
import { useExit } from "./exit"
import { useArgs } from "./args"
import { batch, onMount } from "solid-js"
import path from "path"
import { useKV } from "./kv"
import { usePermission } from "./permission"
import { completeHistory, historyEvictions, type HistoryPage } from "../../../uptokey/history.ts"

const emptyConsoleState: ConsoleState = {
  consoleManagedProviders: [],
  switchableOrgCount: 0,
}

function search<T>(items: T[], target: string, key: (item: T) => string) {
  let left = 0
  let right = items.length - 1
  while (left <= right) {
    const middle = Math.floor((left + right) / 2)
    const value = key(items[middle])
    if (value === target) return { found: true, index: middle }
    if (value < target) left = middle + 1
    else right = middle - 1
  }
  return { found: false, index: left }
}

function compareMessage(a: Message, b: Message) {
  return a.time.created - b.time.created || a.id.localeCompare(b.id)
}

const messageKey = (message: Message) => message.time.created + message.id

export const {
  context: SyncContext,
  use: useSync,
  provider: SyncProvider,
} = createSimpleContext({
  name: "Sync",
  init: () => {
    const startup = useTuiStartup()
    const kv = useKV()
    const permission = usePermission()
    const [store, setStore] = createStore<{
      status: "loading" | "partial" | "complete"
      provider: Provider[]
      provider_default: Record<string, string>
      provider_next: ProviderListResponse
      console_state: ConsoleState
      capabilities: {
        experimentalBackgroundSubagents: boolean
      }
      provider_auth: Record<string, ProviderAuthMethod[]>
      agent: Agent[]
      command: Command[]
      permission: {
        [sessionID: string]: PermissionRequest[]
      }
      question: {
        [sessionID: string]: QuestionRequest[]
      }
      config: Config
      session: Session[]
      session_status: {
        [sessionID: string]: SessionStatus
      }
      session_diff: {
        [sessionID: string]: SnapshotFileDiff[]
      }
      todo: {
        [sessionID: string]: Todo[]
      }
      message: {
        [sessionID: string]: Message[]
      }
      part: {
        [messageID: string]: Part[]
      }
      history: { [sessionID: string]: { before?: string; more: boolean; expanded: boolean; loading: boolean } }
      lsp: LspStatus[]
      mcp: {
        [key: string]: McpStatus
      }
      mcp_resource: {
        [key: string]: McpResource
      }
      formatter: FormatterStatus[]
      vcs: VcsInfo | undefined
    }>({
      provider_next: {
        all: [],
        default: {},
        connected: [],
      },
      console_state: emptyConsoleState,
      capabilities: {
        experimentalBackgroundSubagents: false,
      },
      provider_auth: {},
      config: {},
      status: "loading",
      agent: [],
      permission: {},
      question: {},
      command: [],
      provider: [],
      provider_default: {},
      session: [],
      session_status: {},
      session_diff: {},
      todo: {},
      message: {},
      part: {},
      history: {},
      lsp: [],
      mcp: {},
      mcp_resource: {},
      formatter: [],
      vcs: undefined,
    })

    const event = useEvent()
    const project = useProject()
    const sdk = useSDK()

    const fullSyncedSessions = new Set<string>()
    const syncingSessions = new Map<string, Promise<void>>()
    const hydratingSessions = new Map<string, { messages: Set<string>; parts: Set<string>; cancelled: boolean }>()
    const pagingSessions = new Map<string, Promise<void>>()
    let currentSession: string | undefined
    let recentSessions: string[] = []
    const retain = (sessionID: string) => {
      currentSession = sessionID
      recentSessions = [sessionID, ...recentSessions.filter(id => id !== sessionID)]
      trimHistory()
    }
    function trimHistory() {
      const protectedIDs = new Set([...hydratingSessions.keys(), ...pagingSessions.keys()])
      for (const id of recentSessions) {
        if (store.session_status[id]?.type === "busy" || store.session_status[id]?.type === "retry"
          || store.permission[id]?.length || store.question[id]?.length
          || store.message[id]?.some(message => message.role === "assistant" && !message.time.completed)) protectedIDs.add(id)
      }
      const evictions = historyEvictions(recentSessions, currentSession, protectedIDs)
      if (!evictions.length) return
      const evicted = new Set(evictions)
      recentSessions = recentSessions.filter(id => !evicted.has(id))
      for (const id of evictions) fullSyncedSessions.delete(id)
      setStore(produce(draft => {
        for (const id of evictions) {
          for (const message of draft.message[id] ?? []) {
            markRemoved(id, message.id)
            const retained = draft.part[message.id]?.filter(part => part.sessionID !== id)
            if (retained?.length) draft.part[message.id] = retained
            else delete draft.part[message.id]
          }
          delete draft.message[id]
          delete draft.history[id]
          delete draft.session_diff[id]
        }
      }))
    }
    // Tombstones contain identities only, never message bodies. A canonical parent update or
    // acknowledged hydration starts a new lifetime; late child events cannot resurrect old text.
    const deletedSessions = new Set<string>()
    const removedMessages = new Map<string, Set<string>>()
    const markRemoved = (sessionID: string, messageID: string) => {
      let removed = removedMessages.get(sessionID)
      if (!removed) removedMessages.set(sessionID, removed = new Set())
      removed.add(messageID)
    }
    const removed = (sessionID: string, messageID: string) => deletedSessions.has(sessionID) || removedMessages.get(sessionID)?.has(messageID)
    const touchMessage = (sessionID: string, messageID: string) => {
      hydratingSessions.get(sessionID)?.messages.add(messageID)
    }
    const touchPart = (sessionID: string, partID: string) => {
      hydratingSessions.get(sessionID)?.parts.add(partID)
    }

    function sessionListQuery(): { scope?: "project"; path?: string } {
      if (!kv.get("session_directory_filter_enabled", true)) return { scope: "project" }
      if (!project.data.instance.path.worktree || !project.data.instance.path.directory) return { scope: "project" }
      return {
        path: path
          .relative(path.resolve(project.data.instance.path.worktree), project.data.instance.path.directory)
          .replaceAll("\\", "/"),
      }
    }

    function listSessions() {
      return sdk.client.session
        .list({ start: Date.now() - 30 * 24 * 60 * 60 * 1000, ...sessionListQuery() })
        .then((x) => (x.data ?? []).toSorted((a, b) => a.id.localeCompare(b.id)))
    }

    event.subscribe((event, { directory, workspace }) => {
      switch (event.type) {
        case "server.instance.disposed":
          void bootstrap()
          break
        case "permission.replied": {
          const requests = store.permission[event.properties.sessionID]
          if (!requests) break
          const match = search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) break
          setStore(
            "permission",
            event.properties.sessionID,
            produce((draft: any) => {
              draft.splice(match.index, 1)
            }),
          )
          break
        }

        case "permission.asked": {
          const request = event.properties
          // UPTOKEY MODIFICATION: decisions raised by the Uptokey controller are never auto-approved by a UI toggle.
          if (permission.mode === "auto" && request.metadata?.uptokey !== true) {
            void sdk.client.permission.reply({
              requestID: request.id,
              reply: "once",
              directory,
              workspace,
            })
            break
          }
          const requests = store.permission[request.sessionID]
          if (!requests) {
            setStore("permission", request.sessionID, [request])
            break
          }
          const match = search(requests, request.id, (r) => r.id)
          if (match.found) {
            setStore("permission", request.sessionID, match.index, reconcile(request))
            break
          }
          setStore(
            "permission",
            request.sessionID,
            produce((draft: any) => {
              draft.splice(match.index, 0, request)
            }),
          )
          break
        }

        case "question.replied":
        case "question.rejected": {
          const requests = store.question[event.properties.sessionID]
          if (!requests) break
          const match = search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) break
          setStore(
            "question",
            event.properties.sessionID,
            produce((draft: any) => {
              draft.splice(match.index, 1)
            }),
          )
          break
        }

        case "question.asked": {
          const request = event.properties
          const requests = store.question[request.sessionID]
          if (!requests) {
            setStore("question", request.sessionID, [request])
            break
          }
          const match = search(requests, request.id, (r) => r.id)
          if (match.found) {
            setStore("question", request.sessionID, match.index, reconcile(request))
            break
          }
          setStore(
            "question",
            request.sessionID,
            produce((draft: any) => {
              draft.splice(match.index, 0, request)
            }),
          )
          break
        }

        case "todo.updated":
          setStore("todo", event.properties.sessionID, event.properties.todos)
          break

        case "session.diff":
          setStore("session_diff", event.properties.sessionID, event.properties.diff)
          break

        case "session.deleted": {
          const sessionID = event.properties.info.id
          deletedSessions.add(sessionID)
          const pending = hydratingSessions.get(sessionID)
          if (pending) pending.cancelled = true
          fullSyncedSessions.delete(sessionID)
          syncingSessions.delete(sessionID)
          hydratingSessions.delete(sessionID)
          // A page in flight belongs to the deleted lifetime: its tracker is cancelled above.
          pagingSessions.delete(sessionID)
          recentSessions = recentSessions.filter(id => id !== sessionID)
          if (currentSession === sessionID) currentSession = undefined
          // Removed conversations must release their text/tool outputs, including parts whose message
          // was removed earlier. Do not retain a second in-memory history after canonical deletion.
          setStore(produce((draft) => {
            const result = search(draft.session, sessionID, (s) => s.id)
            if (result.found) draft.session.splice(result.index, 1)
            for (const [messageID, parts] of Object.entries(draft.part)) {
              const retained = parts.filter((part) => part.sessionID !== sessionID)
              if (retained.length === parts.length) continue
              markRemoved(sessionID, messageID)
              if (retained.length) draft.part[messageID] = retained
              else delete draft.part[messageID]
            }
            for (const message of draft.message[sessionID] ?? []) markRemoved(sessionID, message.id)
            delete draft.message[sessionID]
            delete draft.session_status[sessionID]
            delete draft.session_diff[sessionID]
            delete draft.todo[sessionID]
            delete draft.permission[sessionID]
            delete draft.question[sessionID]
            delete draft.history[sessionID]
          }))
          break
        }
        case "session.updated": {
          deletedSessions.delete(event.properties.info.id)
          const result = search(store.session, event.properties.info.id, (s) => s.id)
          if (result.found) {
            setStore("session", result.index, reconcile(event.properties.info))
            break
          }
          setStore(
            "session",
            produce((draft: any) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )
          break
        }

        case "session.next.moved": {
          const result = search(store.session, event.properties.sessionID, (s) => s.id)
          if (!result.found) break
          setStore(
            "session",
            result.index,
            produce((session) => {
              session.directory = event.properties.location.directory
              session.path = event.properties.subdirectory
              session.workspaceID = event.properties.location.workspaceID
              session.time.updated = event.properties.timestamp
            }),
          )
          break
        }

        case "session.status": {
          setStore("session_status", event.properties.sessionID, event.properties.status)
          queueMicrotask(trimHistory)
          break
        }

        case "message.updated": {
          if (deletedSessions.has(event.properties.info.sessionID)) break
          const priorRemoved = removedMessages.get(event.properties.info.sessionID)
          priorRemoved?.delete(event.properties.info.id)
          if (priorRemoved?.size === 0) removedMessages.delete(event.properties.info.sessionID)
          touchMessage(event.properties.info.sessionID, event.properties.info.id)
          const messages = store.message[event.properties.info.sessionID]
          if (!messages) {
            setStore("message", event.properties.info.sessionID, [event.properties.info])
            break
          }
          const result = search(messages, messageKey(event.properties.info), messageKey)
          if (result.found) {
            setStore("message", event.properties.info.sessionID, result.index, reconcile(event.properties.info))
            break
          }
          setStore(
            "message",
            event.properties.info.sessionID,
            produce((draft: any) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )
          const updated = store.message[event.properties.info.sessionID] ?? []
          // A new prompt returns an expanded window to the live tail: older pages stay reloadable.
          if (event.properties.info.role === "user" && store.history[event.properties.info.sessionID]?.expanded && updated.length > 100) {
            const sessionID = event.properties.info.sessionID
            setStore(produce(draft => {
              const list = draft.message[sessionID] ?? []
              const dropped = list.splice(0, list.length - 100)
              for (const message of dropped) { markRemoved(sessionID, message.id); delete draft.part[message.id] }
              draft.history[sessionID] = { before: list[0]?.id, more: true, expanded: false, loading: false }
            }))
            break
          }
          if (updated.length > 100 && !store.history[event.properties.info.sessionID]?.expanded) {
            const oldest = updated[0]
            if (!oldest) break
            markRemoved(event.properties.info.sessionID, oldest.id)
            batch(() => {
              setStore(
                "message",
                event.properties.info.sessionID,
                produce((draft: any) => {
                  draft.shift()
                }),
              )
              setStore(
                "part",
                produce((draft) => {
                  delete draft[oldest.id]
                }),
              )
            })
            if (store.history[event.properties.info.sessionID]) setStore("history", event.properties.info.sessionID, { before: store.message[event.properties.info.sessionID]?.[0]?.id, more: true })
          }
          break
        }
        case "message.removed": {
          const { sessionID, messageID } = event.properties
          markRemoved(sessionID, messageID)
          touchMessage(sessionID, messageID)
          setStore(produce((draft) => {
            const messages = draft.message[sessionID]
            const index = messages?.findIndex((message) => message.id === messageID) ?? -1
            if (index !== -1) messages.splice(index, 1)
            const parts = draft.part[messageID]
            if (!parts) return
            const retained = parts.filter((part) => part.sessionID !== sessionID)
            if (retained.length) draft.part[messageID] = retained
            else delete draft.part[messageID]
          }))
          break
        }
        case "message.part.updated": {
          const incoming = event.properties.part
          if (removed(incoming.sessionID, incoming.messageID)) break
          touchPart(event.properties.part.sessionID, event.properties.part.id)
          const parts = store.part[event.properties.part.messageID]
          if (!parts) {
            setStore("part", event.properties.part.messageID, [event.properties.part])
            break
          }
          const result = search(parts, event.properties.part.id, (part) => part.id)
          if (result.found) {
            setStore("part", event.properties.part.messageID, result.index, reconcile(event.properties.part))
            break
          }
          setStore(
            "part",
            event.properties.part.messageID,
            produce((draft: any) => {
              draft.splice(result.index, 0, event.properties.part)
            }),
          )
          break
        }

        case "message.part.delta": {
          if (removed(event.properties.sessionID, event.properties.messageID)) break
          const parts = store.part[event.properties.messageID]
          if (!parts) break
          const result = search(parts, event.properties.partID, (part) => part.id)
          if (!result.found) break
          touchPart(event.properties.sessionID, event.properties.partID)
          setStore(
            "part",
            event.properties.messageID,
            produce((draft) => {
              const part = draft[result.index]
              const field = event.properties.field as keyof typeof part
              const existing = part[field] as string | undefined
              ;(part[field] as string) = (existing ?? "") + event.properties.delta
            }),
          )
          break
        }

        case "message.part.removed": {
          if (removed(event.properties.sessionID, event.properties.messageID)) break
          touchPart(event.properties.sessionID, event.properties.partID)
          const parts = store.part[event.properties.messageID]
          // The parent message/session may have been removed by an earlier event in this batch.
          if (!parts) break
          const result = search(parts, event.properties.partID, (part) => part.id)
          if (result.found) {
            setStore(
              "part",
              event.properties.messageID,
              produce((draft: any) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          break
        }

        case "lsp.updated": {
          const workspace = project.workspace.current()
          void sdk.client.lsp.status({ workspace }).then((x) => setStore("lsp", x.data ?? []))
          break
        }

        case "vcs.branch.updated": {
          if (workspace === project.workspace.current()) {
            setStore("vcs", { branch: event.properties.branch })
          }
          break
        }
      }
    })

    const exit = useExit()
    const args = useArgs()

    async function bootstrap(input: { fatal?: boolean } = {}) {
      const fatal = input.fatal ?? true
      const workspace = project.workspace.current()
      const projectPromise = project.sync()
      const sessionListPromise = projectPromise.then(() => listSessions())

      // blocking - include session.list when continuing a session
      const providersPromise = sdk.client.config.providers({ workspace }, { throwOnError: true })
      const providerListPromise = sdk.client.provider.list({ workspace }, { throwOnError: true })
      const capabilitiesPromise = sdk.client.experimental.capabilities
        .get({ workspace }, { throwOnError: true })
        .then((x) => x.data)
        .catch(() => undefined)
      const consoleStatePromise = sdk.client.experimental.console
        .get({ workspace }, { throwOnError: true })
        .then((x) => x.data)
        .catch(() => emptyConsoleState)
      const agentsPromise = sdk.client.app.agents({ workspace }, { throwOnError: true })
      const configPromise = sdk.client.config.get({ workspace }, { throwOnError: true })
      await Promise.all([
        providersPromise,
        providerListPromise,
        capabilitiesPromise,
        agentsPromise,
        configPromise,
        projectPromise,
        ...(args.continue ? [sessionListPromise] : []),
      ])
        .then(async () => {
          const providersResponse = providersPromise.then((x) => x.data!)
          const providerListResponse = providerListPromise.then((x) => x.data!)
          const capabilitiesResponse = capabilitiesPromise
          const consoleStateResponse = consoleStatePromise
          const agentsResponse = agentsPromise.then((x) => x.data ?? [])
          const configResponse = configPromise.then((x) => x.data!)
          const sessionListResponse = args.continue ? sessionListPromise : undefined

          return Promise.all([
            providersResponse,
            providerListResponse,
            capabilitiesResponse,
            consoleStateResponse,
            agentsResponse,
            configResponse,
            ...(sessionListResponse ? [sessionListResponse] : []),
          ]).then((responses) => {
            const providers = responses[0]
            const providerList = responses[1]
            const capabilities = responses[2]
            const consoleState = responses[3]
            const agents = responses[4]
            const config = responses[5]
            const sessions = responses[6]

            batch(() => {
              setStore("provider", reconcile(providers.providers))
              setStore("provider_default", reconcile(providers.default))
              setStore("provider_next", reconcile(providerList))
              setStore("capabilities", "experimentalBackgroundSubagents", capabilities?.backgroundSubagents === true)
              setStore("console_state", reconcile(consoleState))
              setStore("agent", reconcile(agents))
              setStore("config", reconcile(config))
              if (sessions !== undefined) setStore("session", reconcile(sessions))
            })
          })
        })
        .then(() => {
          if (store.status !== "complete") setStore("status", "partial")
          traceBoot("boot.sync_partial")
          // non-blocking
          void Promise.all([
            ...(args.continue ? [] : [sessionListPromise.then((sessions) => setStore("session", reconcile(sessions)))]),
            consoleStatePromise.then((consoleState) => setStore("console_state", reconcile(consoleState))),
            sdk.client.command.list({ workspace }).then((x) => setStore("command", reconcile(x.data ?? []))),
            sdk.client.lsp.status({ workspace }).then((x) => setStore("lsp", reconcile(x.data ?? []))),
            sdk.client.mcp.status({ workspace }).then((x) => setStore("mcp", reconcile(x.data ?? {}))),
            sdk.client.experimental.resource
              .list({ workspace })
              .then((x) => setStore("mcp_resource", reconcile(x.data ?? {}))),
            sdk.client.formatter.status({ workspace }).then((x) => setStore("formatter", reconcile(x.data ?? []))),
            sdk.client.session.status({ workspace }).then((x) => {
              setStore("session_status", reconcile(x.data ?? {}))
            }),
            sdk.client.provider.auth({ workspace }).then((x) => setStore("provider_auth", reconcile(x.data ?? {}))),
            sdk.client.vcs.get({ workspace }).then((x) => setStore("vcs", reconcile(x.data))),
            project.workspace.sync(),
          ]).then(() => {
            setStore("status", "complete")
          })
        })
        .catch(async (e) => {
          console.error("tui bootstrap failed", {
            error: e instanceof Error ? e.message : String(e),
            name: e instanceof Error ? e.name : undefined,
            stack: e instanceof Error ? e.stack : undefined,
          })
          if (fatal) {
            exit(e)
          } else {
            throw e
          }
        })
    }

    onMount(() => {
      void bootstrap()
    })

    const result = {
      data: store,
      set: setStore,
      get status() {
        return store.status
      },
      get ready() {
        if (startup.skipInitialLoading) return true
        return store.status !== "loading"
      },
      get path() {
        return project.instance.path()
      },
      session: {
        retain,
        release(sessionID: string) { if (currentSession === sessionID) currentSession = undefined },
        message: {
          more(sessionID: string) { return store.history[sessionID]?.more === true },
          loading(sessionID: string) { return store.history[sessionID]?.loading === true },
          all(sessionID: string) { return completeHistory(sdk.client, sessionID) },
          async loadMore(sessionID: string) {
            const existing = pagingSessions.get(sessionID)
            if (existing) return existing
            // One hydration owner per session: a page never replaces an in-flight full sync tracker.
            const syncing = syncingSessions.get(sessionID)
            if (syncing) await syncing
            if (pagingSessions.get(sessionID)) return pagingSessions.get(sessionID)
            if (!store.history[sessionID]?.more) return
            const before = store.history[sessionID]?.before ?? store.message[sessionID]?.[0]?.id
            if (!before) return
            const tracker = { messages: new Set<string>(), parts: new Set<string>(), cancelled: false }
            hydratingSessions.set(sessionID, tracker)
            setStore("history", sessionID, "loading", true)
            const task = (async () => {
              const page: HistoryPage = await sdk.client.session.messages({ sessionID, limit: 100, before })
              if (tracker.cancelled) return
              if (page.error || !Array.isArray(page.data)) throw Error("conversation_history_unavailable")
              if (page.meta?.more && (!page.meta.before || page.meta.before === before)) throw Error("conversation_history_cursor_changed")
              setStore(produce(draft => {
                const merged = new Map((draft.message[sessionID] ?? []).map(message => [message.id, message]))
                for (const message of page.data) {
                  if (tracker.messages.has(message.info.id) && !merged.has(message.info.id)) continue
                  if (!merged.has(message.info.id)) merged.set(message.info.id, message.info)
                  removedMessages.get(sessionID)?.delete(message.info.id)
                  const current = draft.part[message.info.id] ?? []
                  const parts = new Map(current.map(part => [part.id, part]))
                  for (const part of message.parts) if (!tracker.parts.has(part.id) && !parts.has(part.id)) parts.set(part.id, part)
                  draft.part[message.info.id] = [...parts.values()].sort((a, b) => a.id.localeCompare(b.id))
                }
                draft.message[sessionID] = [...merged.values()].sort(compareMessage)
                draft.history[sessionID] = { before: page.meta?.before ?? page.data[0]?.info.id, more: page.meta?.more === true, expanded: true, loading: false }
              }))
            })().finally(() => {
              if (pagingSessions.get(sessionID) === task) pagingSessions.delete(sessionID)
              if (hydratingSessions.get(sessionID) === tracker) hydratingSessions.delete(sessionID)
              if (store.history[sessionID] && !tracker.cancelled) setStore("history", sessionID, "loading", false)
              trimHistory()
            })
            pagingSessions.set(sessionID, task)
            return task
          },
        },
        get(sessionID: string) {
          const match = search(store.session, sessionID, (s) => s.id)
          if (match.found) return store.session[match.index]
          return undefined
        },
        query() {
          return sessionListQuery()
        },
        async refresh() {
          const list = await listSessions()
          setStore("session", reconcile(list))
        },
        status(sessionID: string) {
          const session = result.session.get(sessionID)
          if (!session) return "idle"
          if (session.time.compacting) return "compacting"
          const messages = store.message[sessionID] ?? []
          const last = messages.at(-1)
          if (!last) return "idle"
          if (last.role === "user") return "working"
          return last.time.completed ? "idle" : "working"
        },
        async sync(sessionID: string) {
          retain(sessionID)
          if (fullSyncedSessions.has(sessionID)) return
          const syncing = syncingSessions.get(sessionID)
          if (syncing) return syncing
          const tracker = { messages: new Set<string>(), parts: new Set<string>(), cancelled: false }
          hydratingSessions.set(sessionID, tracker)
          const task = (async () => {
            const [session, messages, todo, diff] = await Promise.all([
              sdk.client.session.get({ sessionID }, { throwOnError: true }),
              sdk.client.session.messages({ sessionID, limit: 100 }),
              sdk.client.session.todo({ sessionID }),
              sdk.client.session.diff({ sessionID }),
            ])
            if (tracker.cancelled) return
            deletedSessions.delete(sessionID)
            setStore(
              produce((draft) => {
                const match = search(draft.session, sessionID, (s) => s.id)
                if (match.found) draft.session[match.index] = session.data!
                if (!match.found) draft.session.splice(match.index, 0, session.data!)
                draft.todo[sessionID] = todo.data ?? []
                const currentMessages = draft.message[sessionID] ?? []
                const infos = (messages.data ?? []).flatMap((message) => {
                  if (!tracker.messages.has(message.info.id)) return [message.info]
                  const current = currentMessages.find((item) => item.id === message.info.id)
                  return current ? [current] : []
                })
                infos.push(
                  ...currentMessages.filter(
                    (message) => tracker.messages.has(message.id) && !infos.some((item) => item.id === message.id),
                  ),
                )
                infos.sort(compareMessage)
                const removed = infos.slice(0, -100)
                const visible = infos.slice(-100)
                const visibleIDs = new Set(visible.map((message) => message.id))
                const tombstones = removedMessages.get(sessionID)
                if (tombstones) {
                  for (const message of visible) tombstones.delete(message.id)
                  if (tombstones.size === 0) removedMessages.delete(sessionID)
                }
                for (const message of messages.data ?? []) {
                  if (!visibleIDs.has(message.info.id)) {
                    markRemoved(sessionID, message.info.id)
                    delete draft.part[message.info.id]
                    continue
                  }
                  const currentParts = draft.part[message.info.id] ?? []
                  const parts = message.parts.flatMap((part) => {
                    const current = currentParts.find((item) => item.id === part.id)
                    if (tracker.parts.has(part.id)) return current ? [current] : []
                    if (
                      current &&
                      (part.type === "text" || part.type === "reasoning") &&
                      (current.type === "text" || current.type === "reasoning") &&
                      part.text.length === 0 &&
                      current.text.length > 0
                    ) {
                      return [current]
                    }
                    return [part]
                  })
                  parts.push(
                    ...currentParts.filter(
                      (part) => tracker.parts.has(part.id) && !parts.some((item) => item.id === part.id),
                    ),
                  )
                  draft.part[message.info.id] = parts
                }
                for (const message of removed) {
                  markRemoved(sessionID, message.id)
                  delete draft.part[message.id]
                }
                draft.message[sessionID] = visible
                const page = messages as HistoryPage
                draft.history[sessionID] = { before: page.meta?.before ?? visible[0]?.id, more: page.meta?.more === true, expanded: false, loading: false }
                draft.session_diff[sessionID] = diff.data ?? []
              }),
            )
            fullSyncedSessions.add(sessionID)
          })().finally(() => {
            if (syncingSessions.get(sessionID) === task) syncingSessions.delete(sessionID)
            if (hydratingSessions.get(sessionID) === tracker) hydratingSessions.delete(sessionID)
            trimHistory()
          })
          syncingSessions.set(sessionID, task)
          return task
        },
      },
      bootstrap,
    }
    return result
  },
})
