import { UpdateJournal, waitForUpdateHealth, type UpdateTransaction } from "./update-transaction.ts";

export interface PlatformUpdateInstaller {
  candidatePid?: number;
  install(transaction: UpdateTransaction): Promise<void>;
  rollback(transaction: UpdateTransaction): Promise<void>;
}

export class UpdateCoordinator {
  constructor(privateJournal: UpdateJournal, privateInstaller: PlatformUpdateInstaller, privateHealth: (version: string) => Promise<void> = waitForUpdateHealth) {
    this.journal = privateJournal; this.installer = privateInstaller; this.health = privateHealth;
  }
  private readonly journal: UpdateJournal;
  private readonly installer: PlatformUpdateInstaller;
  private readonly health: (version: string) => Promise<void>;

  async installStaged(): Promise<UpdateTransaction> {
    const staged = await this.journal.load(); if (!staged || staged.state !== "staged") throw new Error("update_staged_transaction_required");
    let current = await this.journal.transition("staged", "installing");
    try {
      await this.installer.install(current);
      if (this.installer.candidatePid !== undefined) current = await this.journal.recordCandidatePid(this.installer.candidatePid);
      current = await this.journal.transition("installing", "awaiting-health");
      await this.health(current.toVersion);
      return this.journal.transition("awaiting-health", "healthy");
    } catch (error) {
      const reason = error instanceof Error ? error.message : "update_install_failed";
      const latest = await this.journal.load();
      if (!latest || (latest.state !== "installing" && latest.state !== "awaiting-health")) throw error;
      const rolling = await this.journal.transition(latest.state, "rolling-back", new Date(), reason);
      try { await this.installer.rollback(rolling); return this.journal.transition("rolling-back", "rolled-back", new Date(), reason); }
      catch (rollbackError) { const rollbackReason = rollbackError instanceof Error ? rollbackError.message : "update_rollback_failed"; await this.journal.transition("rolling-back", "failed", new Date(), rollbackReason); throw new Error("update_install_and_rollback_failed"); }
    }
  }
}
