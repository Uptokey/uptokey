/**
 * The vendored frontend was written against OpenCode's server API. Endpoints Uptokey does not provide must
 * fail visibly: callers receive the SDK error shape (or a rejection with throwOnError), never fabricated data.
 */
export interface UnsupportedError {
  name: "UnsupportedByUptokey"
  data: { message: string }
}

type CallOptions = { throwOnError?: boolean } | undefined
import { ui } from '../i18n.ts'

function unsupportedCall(path: string[], args: unknown[]) {
  const error: UnsupportedError = { name: "UnsupportedByUptokey", data: { message: ui('panel_unavailable',{name:path.join('.')}) } }
  const options = args.at(-1) as CallOptions
  if (options && typeof options === "object" && options.throwOnError) return Promise.reject(Object.assign(new Error(error.data.message), error))
  return Promise.resolve({ data: undefined, error })
}

export function unsupported(path: string[]): unknown {
  const call = (...args: unknown[]) => unsupportedCall(path, args)
  return new Proxy(call, {
    get(_target, key) {
      if (typeof key !== "string" || key === "then") return undefined
      return unsupported([...path, key])
    },
  })
}

/** Wraps a table of implemented endpoints; any other path resolves to the explicit unsupported result. */
export function withUnsupported<T extends object>(known: T, path: string[] = []): T {
  return new Proxy(known, {
    get(target, key, receiver) {
      if (typeof key !== "string" || key === "then") return Reflect.get(target, key, receiver)
      if (key in target) {
        const value = Reflect.get(target, key, receiver)
        if (value && typeof value === "object" && !Array.isArray(value)) return withUnsupported(value as object, [...path, key])
        return value
      }
      return unsupported([...path, key])
    },
  }) as T
}
