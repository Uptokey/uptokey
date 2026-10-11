export const RATE_SUBJECT_HEADER: string;
export const RATE_TIMESTAMP_HEADER: string;
export const RATE_SIGNATURE_HEADER: string;
export function signRateSubject(clientIp: string, secret: string, nowSeconds?: number): Record<string, string>;
export function verifyRateSubject(headers: Headers, secret: string, nowSeconds?: number, maximumSkewSeconds?: number): string | undefined;
