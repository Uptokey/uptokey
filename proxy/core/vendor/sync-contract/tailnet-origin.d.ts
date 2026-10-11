export const TAILNET_CONTROL_PORT: "21436";
export const TAILNET_CSP_SOURCE: "https://*.ts.net:21436";
export const TAILNET_CONTROL_ORIGIN_LEASE_MS: 180000;
export const TAILNET_CONTROL_ORIGIN_RENEW_MS: 60000;
export function parseTailnetControlOrigin(raw: unknown): string | undefined;
