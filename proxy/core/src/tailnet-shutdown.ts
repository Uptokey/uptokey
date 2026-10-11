export interface TailnetShutdownSteps {
  stopLease(): void | Promise<unknown>;
  stopListener(): void | Promise<unknown>;
  removeServe(): void | Promise<unknown>;
}

export async function shutdownTailnet(steps: TailnetShutdownSteps): Promise<void> {
  let failed = false;
  for (const step of [steps.stopLease, steps.stopListener, steps.removeServe]) {
    try { await step(); } catch { failed = true; }
  }
  if (failed) throw new Error("tailnet_shutdown_failed");
}
