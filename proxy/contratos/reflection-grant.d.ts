/** Reflection grant contract v1 — one W5 consent covers the write plan and up to 3 coder reflections. */
export declare const REFLECTION_GRANT_VERSION: 1;
export declare const REFLECTION_LIMITS: Readonly<{
  maxAttempts: 3;
  maxTokensPerAttempt: 4096;
  totalTokenCeiling: 12288;
  ttlMs: 300000;
}>;
export declare class ReflectionGrantError extends Error {
  code: string;
  constructor(code?: string);
}
export interface ReflectionGrant {
  readonly schemaVersion: 1;
  readonly maxAttempts: 3;
  readonly maxTokensPerAttempt: 4096;
  readonly totalTokenCeiling: 12288;
  /** Reference to the single W5 consent that covers write plan + reflections. */
  readonly consentRef: string;
  readonly issuedAt: string;
  /** issuedAt + ttlMs (5 minutes). Exhausted budget or deadline requires a new W5. */
  readonly expiresAt: string;
}
export declare function createReflectionGrant(input: { consentRef: string; issuedAt: string }): ReflectionGrant;
export declare function parseReflectionGrant(input: unknown): ReflectionGrant;
export declare function reflectionGrantActive(grant: ReflectionGrant, now?: string): boolean;
export declare function reflectionGrantCovers(grant: ReflectionGrant, usage: { attempts: number; inputTokens: number; outputTokens: number }): boolean;
export declare function reflectionGrantDigest(grant: ReflectionGrant): string;
