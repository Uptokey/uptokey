export interface EnvelopeCredential { id: string; publicKey: string; counter: number; transports?: string[]; }
export function envelopeChallenge(tenantId: string, envelope: Record<string, unknown>): string;
export function verifyEnvelopeAssertion(input: { assertion: unknown; credential: EnvelopeCredential; tenantId: string; envelope: Record<string, unknown>; expectedOrigin: string | string[]; expectedRPID: string | string[] }, verifyResponse?: (options: unknown) => Promise<unknown>): Promise<number>;
