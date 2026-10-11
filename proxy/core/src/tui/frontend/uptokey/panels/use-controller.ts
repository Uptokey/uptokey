import { createSignal, onCleanup } from "solid-js"
import { getBackend } from "../backend/registry.ts"

/**
 * A signal that changes when the controller reports a change, so panels can re-read `controller.view`.
 * Updates are coalesced (at most one per interval): the controller can emit many changes per second while a turn
 * streams, and re-rendering an open dialog for each one would steal time from key handling.
 */
export function useControllerTick(intervalMs = 150) {
  const backend = getBackend()
  const [tick, setTick] = createSignal(0)
  let timer: ReturnType<typeof setTimeout> | undefined
  const off = backend.onChange(() => {
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      setTick((value) => value + 1)
    }, intervalMs)
  })
  onCleanup(() => {
    off()
    if (timer) clearTimeout(timer)
  })
  return tick
}
