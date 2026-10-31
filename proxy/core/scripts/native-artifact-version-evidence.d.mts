export interface NativeIdentityExpectation {
  version: string;
  targetOs: "windows" | "macos" | "linux";
  targetArch: "x86_64" | "aarch64";
  defaultInterface: "Harness" | "shell";
  sourceCommit: string;
}
export interface NativeBuildIdentity {
  schema: "uptokey-native-build-identity-v1";
  product: "uptokey-tauri";
  version: string;
  defaultInterface: "Harness" | "shell";
  target: { os: NativeIdentityExpectation["targetOs"]; arch: NativeIdentityExpectation["targetArch"] };
  sourceCommit: string;
}
export interface NativeArtifactVersionReceipt {
  schema: "uptokey-native-artifact-build-evidence-v1";
  identity: NativeBuildIdentity;
  artifact: string;
  subjectSha256: string;
  checks: { staticCommandSupport: true; executableBuildIdentity: true };
}
export const NATIVE_IDENTITY_COMMAND: "--native-build-identity";
export const NATIVE_IDENTITY_SCHEMA: "uptokey-native-build-identity-v1";
export function validateNativeBuildIdentity(value: unknown, expected: NativeIdentityExpectation): string[];
export function validateNativeArtifactVersionReceipt(value: unknown, expected: NativeIdentityExpectation & { artifact: string; subjectSha256: string }): string[];
export function createNativeArtifactVersionEvidence(options: NativeIdentityExpectation & { artifactPath: string; outputPath: string; expectedSubjectSha256: string }): { output: string; receipt: NativeArtifactVersionReceipt };
