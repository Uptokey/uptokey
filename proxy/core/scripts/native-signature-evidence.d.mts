export interface NativeReceipt {
  schema: string;
  platform: "windows" | "macos" | "linux";
  subjectSha256: string;
  verifiedAt: string;
  toolchain: string[];
  signer: Record<string, unknown>;
  checks: Record<string, boolean>;
}
export function validateNativeReceipt(receipt: unknown, platform: string, subjectSha256: string): string[];
export function createNativeReceipt(platform: string, artifact: string, options?: { signature?: string; keyring?: string; expectedSigner?: string }): NativeReceipt;
export function createMacosDistributionReceipt(archive: string): Promise<NativeReceipt>;
export function sha256Path(path: string): string;
export function assertMacosKeychainEntitlements(entitlements: string, teamId: string): void;
export function assertLinuxSignerFingerprint(observed: string, expected: string): void;
