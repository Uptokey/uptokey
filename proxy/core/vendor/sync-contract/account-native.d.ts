export interface AccountNativeParseOptions { now?: number; expectedOrigin?: string }
export type AccountNativeLoginResponse =
  | { session: unknown }
  | { loginUrl: string; userCode: string; expiresAt: number };
export interface AccountNativeConnectionResponse { loginUrl: string; expiresAt: number }
export declare function readAccountLoginResponse(value: unknown, options?: AccountNativeParseOptions): AccountNativeLoginResponse;
export declare function readAccountConnectionResponse(value: unknown, options?: AccountNativeParseOptions): AccountNativeConnectionResponse;
export declare function readAccountRetryAfter(value: unknown, now?: number): number;
