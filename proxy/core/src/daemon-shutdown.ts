export interface DaemonShutdownSteps {
  stopPoller(): void | Promise<void>;
  stopTailnet(): void | Promise<void>;
  stopServer(): void | Promise<void>;
  releasePid(): void | Promise<void>;
  exit(code: number): void | Promise<void>;
}

export function createDaemonShutdown(steps: DaemonShutdownSteps): (forceFailure?: boolean) => Promise<void> {
  let started = false;
  let failureRequested = false;
  return async (forceFailure = false) => {
    if (forceFailure) failureRequested = true;
    if (started) return;
    started = true;
    let failed = false;
    for (const step of [steps.stopPoller, steps.stopTailnet, steps.stopServer, steps.releasePid]) {
      try { await step(); } catch { failed = true; }
    }
    try { await steps.exit(failed || failureRequested ? 1 : 0); } catch { /* process.exit real não retorna; mock/falha não vaza */ }
  };
}
