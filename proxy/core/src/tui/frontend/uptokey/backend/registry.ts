import type { UptokeyBackend } from "./index.ts"

let current: UptokeyBackend | undefined

export function setBackend(backend: UptokeyBackend) {
  current = backend
}

export function getBackend() {
  if (!current) throw new Error("Uptokey backend is not initialised")
  return current
}
