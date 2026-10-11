export interface ArtifactVersionReceipt {
  schema: "uptokey-artifact-build-evidence-v2";
  platform: "macos" | "windows" | "linux";
  version: string;
  updateOrigin: string;
  updateTrust: Readonly<{ primaryKeyFingerprint: string; nextKeyFingerprint: string | null }>;
  artifact: string;
  subjectSha256: string;
  checks: Readonly<{ executableBuildIdentity: true }>;
}
export function createArtifactVersionEvidence(options: { platform: string; artifactPath: string; probeCommand: string; probeArgs: string[]; expectedVersion: string; expectedUpdateOrigin: string; expectedPrimaryPublicKeyPath: string; expectedNextPublicKeyPath?: string; outputPath: string }): { output: string; receipt: Readonly<ArtifactVersionReceipt> };
export function validateArtifactVersionReceipt(value: unknown, expected: { platform: string; version: string; updateOrigin: string; primaryKeyFingerprint: string; nextKeyFingerprint: string | null; artifact: string; subjectSha256: string }): string[];
export function validateCompiledBuildIdentity(value: unknown, expected: { version: string; updateOrigin: string; primaryKeyFingerprint: string; nextKeyFingerprint: string | null }): string[];
export function validReleaseVersion(value: unknown): boolean;
