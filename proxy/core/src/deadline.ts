export function createDeadline(milliseconds: number): { signal: AbortSignal; clear: () => void } {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1) throw new Error("deadline_invalid");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("deadline_exceeded")), milliseconds);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}
