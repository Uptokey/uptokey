export interface ProcessOutput {
  on(event: "error", listener: (error: unknown) => void): unknown;
  write(chunk: string): unknown;
}

const contained = new WeakSet<object>();

export function containProcessOutput(stream: ProcessOutput): void {
  if (contained.has(stream as object)) return;
  stream.on("error", () => undefined);
  contained.add(stream as object);
}

export function writeProcessOutput(stream: ProcessOutput, message: string): void {
  containProcessOutput(stream);
  try { stream.write(message); } catch { /* pipe rompido não substitui a decisão da CLI */ }
}
