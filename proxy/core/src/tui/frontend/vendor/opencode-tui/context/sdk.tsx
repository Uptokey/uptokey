// UPTOKEY MODIFICATION (see UPSTREAM.json): the OpenCode HTTP/SSE client is replaced by the in-process Uptokey backend.
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { createSimpleContext } from "./helper"
import { batch, onCleanup, onMount } from "solid-js"
import { getBackend } from "../../../uptokey/backend/registry.ts"

export type EventSource = {
  subscribe: (handler: (event: GlobalEvent) => void) => Promise<() => void>
}

export const { use: useSDK, provider: SDKProvider } = createSimpleContext({
  name: "SDK",
  init: (props: {
    url: string
    directory?: string
    fetch?: typeof fetch
    headers?: RequestInit["headers"]
    events?: EventSource
  }) => {
    const backend = getBackend()
    const handlers = new Set<(event: GlobalEvent) => void>()
    const emitter = {
      emit(_type: "event", event: GlobalEvent) {
        for (const handler of handlers) handler(event)
      },
      on(_type: "event", handler: (event: GlobalEvent) => void) {
        handlers.add(handler)
        return () => {
          handlers.delete(handler)
        }
      },
    }

    let queue: GlobalEvent[] = []
    let timer: Timer | undefined
    let last = 0

    const flush = () => {
      if (queue.length === 0) return
      const events = queue
      queue = []
      timer = undefined
      last = Date.now()
      // One batch per frame window so streaming deltas cause a single store update and render.
      batch(() => {
        for (const event of events) emitter.emit("event", event)
      })
    }

    // Uptokey: events emitted in the same tick (a resync removes and re-adds messages) must land in one batch;
    // flushing the first one synchronously rendered a frame with the messages removed (visible flicker).
    let microtask = false
    const handleEvent = (event: GlobalEvent) => {
      queue.push(event)
      if (timer || microtask) return
      if (Date.now() - last < 16) {
        timer = setTimeout(flush, 16)
        return
      }
      microtask = true
      queueMicrotask(() => {
        microtask = false
        if (!timer) flush()
      })
    }

    onMount(() => {
      const off = backend.subscribe(handleEvent)
      onCleanup(off)
    })

    onCleanup(() => {
      if (timer) clearTimeout(timer)
      handlers.clear()
    })

    return {
      get client() {
        return backend.client
      },
      directory: backend.directory,
      event: emitter,
      fetch: props.fetch ?? fetch,
      url: props.url,
    }
  },
})
