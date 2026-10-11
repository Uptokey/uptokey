/** Common byte-reader surface across DOM, Node and Bun stream declarations. */
export interface ByteReader {
  read(): Promise<{ done: false; value: Uint8Array } | { done: true; value?: Uint8Array }>
  cancel(reason?: unknown): Promise<void>
  releaseLock(): void
}

export async function* byteChunks(reader: ByteReader): AsyncGenerator<Uint8Array> {
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) return
      yield chunk.value
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

/** Native global constructor keeps the Response body in its runtime's own stream implementation. */
export function byteStream(reader: ByteReader): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read()
        if (chunk.done) { controller.close(); reader.releaseLock(); return }
        controller.enqueue(chunk.value)
      } catch (error) { controller.error(error); reader.releaseLock() }
    },
    async cancel(reason) {
      try { await reader.cancel(reason) } finally { reader.releaseLock() }
    },
  })
}
