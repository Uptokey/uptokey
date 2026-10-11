import type { PlatformUpdateInstaller } from "../src/update-coordinator.ts";
export class WindowsExecutableInstaller implements PlatformUpdateInstaller { constructor(options: { journalPath: string; stagedExecutable: string; installedExecutable: string; oldPid: number }); install(transaction: import("../src/update-transaction.ts").UpdateTransaction): Promise<void>; rollback(transaction: import("../src/update-transaction.ts").UpdateTransaction): Promise<void> }
export function runWindowsUpdateHelper(options: { journalPath: string; stagedExecutable: string; installedExecutable: string; oldPid: number }): Promise<import("../src/update-transaction.ts").UpdateTransaction>;
export function windowsInstalledTargetForHelper(helperExecutable: string): string;
export function assertWindowsUpdateSignerContinuity(installedReceipt: unknown, candidateReceipt: unknown): void;
