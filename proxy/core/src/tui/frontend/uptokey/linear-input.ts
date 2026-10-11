import { createInterface } from "node:readline/promises"
import { Writable } from "node:stream"

/** Native readline editing with secret entry excluded from terminal output and input history. */
export function createLinearInput(source: NodeJS.ReadableStream = process.stdin, destination: NodeJS.WritableStream = process.stdout) {
  let hidden = false
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!hidden) destination.write(chunk)
      done()
    },
  })
  const input = createInterface({ input: source, output, terminal: true }) as ReturnType<typeof createInterface> & { history: string[] }
  const ask = async (label: string, secret = false): Promise<string> => {
    if (!secret) return input.question(label)
    destination.write(label)
    const previousHistory = [...input.history]
    hidden = true
    try { return await input.question("") }
    finally {
      input.history.splice(0, input.history.length, ...previousHistory)
      hidden = false
      destination.write("\n")
    }
  }
  return { input, output, ask }
}
