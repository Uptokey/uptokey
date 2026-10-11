import { compiledUpdateOrigin, compiledUpdateTrust } from "./update-trust.ts";
import { RELEASE_VERSION } from "./version.ts";

export interface CompiledBuildIdentity {
  schema: "uptokey-compiled-build-identity-v1";
  version: string;
  updateOrigin: string;
  updateTrust: { primaryKeyFingerprint: string; nextKeyFingerprint: string | null };
}

export function compiledBuildIdentity(): Readonly<CompiledBuildIdentity> {
  const trust = compiledUpdateTrust();
  return Object.freeze({
    schema: "uptokey-compiled-build-identity-v1",
    version: RELEASE_VERSION,
    updateOrigin: compiledUpdateOrigin(),
    updateTrust: Object.freeze({ primaryKeyFingerprint: trust.fingerprint, nextKeyFingerprint: trust.fallbackKeys?.[0]?.fingerprint ?? null }),
  });
}
