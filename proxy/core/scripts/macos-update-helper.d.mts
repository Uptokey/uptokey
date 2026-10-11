import type { PlatformUpdateInstaller } from "../src/update-coordinator.ts";
export class MacosBundleInstaller implements PlatformUpdateInstaller { constructor(options: { journalPath: string; stagedArchive: string; installedApp: string; oldPid: number }); install(transaction: import("../src/update-transaction.ts").UpdateTransaction): Promise<void>; rollback(transaction: import("../src/update-transaction.ts").UpdateTransaction): Promise<void> }
export function inspectMacosUpdateArchive(archivePath: string, limits?: Readonly<{ archiveBytes: number; centralDirectoryBytes: number; entries: number; uncompressedBytes: number; expansionRatio: number }>): Readonly<{ entries: number; compressedBytes: number; uncompressedBytes: number }>;
export function runMacosUpdateHelper(options: { journalPath: string; stagedArchive: string; installedApp: string; oldPid: number }): Promise<import("../src/update-transaction.ts").UpdateTransaction>;
export function macosInstalledTargetForHelper(helperExecutable: string): string;
export function assertMacosUpdateSignerContinuity(installedReceipt: unknown, candidateReceipt: unknown): void;
