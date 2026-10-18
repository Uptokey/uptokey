import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PENDING_STEER_FILE, PendingSteerStore } from "./pending-steer.ts"

const A = "11111111-1111-4111-8111-111111111111"
const B = "22222222-2222-4222-8222-222222222222"

function withState(run: (directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), "uptokey-steer-"))
  try { run(directory) } finally { rmSync(directory, { recursive: true, force: true }) }
}
const saved = (directory: string) => existsSync(join(directory, PENDING_STEER_FILE)) ? JSON.parse(readFileSync(join(directory, PENDING_STEER_FILE), "utf8")) : null

test("a queued redirection survives the process and returns once to its conversation, never to another", () => withState((directory) => {
  const first = new PendingSteerStore(directory)
  expect(first.update(A, ["use the second file"], false)).toBeNull()
  expect(saved(directory)).toEqual([expect.objectContaining({ conversationId: A, texts: ["use the second file"] })])
  // The process is lost here: nothing was delivered. A new process opens another conversation first.
  const second = new PendingSteerStore(directory)
  expect(second.update(B, [], false)).toBeNull()
  expect(saved(directory)[0].conversationId).toBe(A)
  expect(second.update(A, [], false)).toEqual(["use the second file"])
  expect(saved(directory)).toEqual([])
  expect(second.update(A, [], false)).toBeNull()
}))

test("delivered, cancelled or deliberately dropped redirections leave the file", () => withState((directory) => {
  const store = new PendingSteerStore(directory)
  store.update(A, ["one", "two"], false)
  store.update(A, ["two"], false)
  expect(saved(directory)[0].texts).toEqual(["two"])
  store.update(A, [], false)
  expect(saved(directory)).toEqual([])
  store.update(A, ["three"], false)
  // Switching conversations drops the queue on purpose (the controller clears it): the file follows.
  store.update(B, [], false)
  expect(saved(directory)).toEqual([])
  expect(new PendingSteerStore(directory).update(A, [], false)).toBeNull()
}))

test("a temporary conversation never writes its redirections and removes what it had", () => withState((directory) => {
  const store = new PendingSteerStore(directory)
  store.update(A, ["private text"], true)
  expect(saved(directory)).toBeNull()
  store.update(A, ["before"], false)
  store.update(A, ["before"], true)
  expect(saved(directory)).toEqual([])
}))

test("another window's entry and unreadable files are preserved or ignored, not corrupted", () => withState((directory) => {
  writeFileSync(join(directory, PENDING_STEER_FILE), "{not json")
  const store = new PendingSteerStore(directory)
  expect(store.update(A, [], false)).toBeNull()
  writeFileSync(join(directory, PENDING_STEER_FILE), JSON.stringify([{ conversationId: B, texts: ["other window"], savedAt: "x" }]))
  store.update(A, ["mine"], false)
  expect(saved(directory).map((entry: { conversationId: string }) => entry.conversationId).sort()).toEqual([A, B].sort())
  store.update(A, [], false)
  expect(saved(directory)).toEqual([expect.objectContaining({ conversationId: B })])
}))
