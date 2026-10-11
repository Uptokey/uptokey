// In-process serialization per key. Cross-window writers use atomic file replacement instead of advisory locks.
const tails = new Map<string, Promise<unknown>>()

export const Flock = {
  setGlobal(_input: { state: string }) {},
  async withLock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const previous = tails.get(key) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(fn)
    tails.set(key, next.catch(() => undefined))
    return next
  },
}
