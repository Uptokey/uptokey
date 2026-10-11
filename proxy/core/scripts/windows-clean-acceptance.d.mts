export const RECEIPT_SCHEMA_ID: "uptokey-windows-clean-acceptance-v1";
export const ACCEPTANCE_ARTIFACT_NAMES: readonly ["uptokey-windows.exe", "uptokey-update-helper.exe"];

export function sha256File(path: string): string;

export function receiptLeakReason(serialized: string): string | null;

export function expectedArtifacts(distDir: string): Array<{ name: string; path: string }>;

export function buildSandboxConfiguration(hostInDir: string, hostOutDir: string): string;

export function buildAcceptanceManifest(distDir: string, licensePath: string): Readonly<{
  schema: "uptokey-windows-clean-acceptance-manifest-v1";
  expected: Readonly<{
    artifacts: ReadonlyArray<{ name: string; sha256: string }>;
    license_sha256: string;
  }>;
}>;

export function validateReceipt(receipt: unknown): string[];

export function windowsSandboxExecutable(): string | null;
