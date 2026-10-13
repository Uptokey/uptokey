/** Coalesce controller notifications in the next event-loop turn before projecting/diffing history. */
export class CoalescedSync {
  private timer: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  private readonly run: () => void
  private readonly delayMs: number

  constructor(run: () => void, delayMs = 0) {
    this.run = run
    this.delayMs = delayMs
  }

  request() {
    if (this.disposed || this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (!this.disposed) this.run()
    }, this.delayMs)
    this.timer.unref?.()
  }

  /** Explicit session/approval sync consumes pending work instead of replaying it afterward. */
  cancel() {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  dispose() {
    this.disposed = true
    this.cancel()
  }
}
