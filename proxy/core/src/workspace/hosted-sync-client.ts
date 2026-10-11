/**
 * B9-reparo (frente B) — cliente do transporte hospedado B8
 * (`/v1/hosted/sync/:objectId`, `/v1/hosted/recovery/:recoveryId`).
 *
 * Autoridades separadas: o token de conta (Auth0, emitido fora do core) vem de
 * uma fonte injetada; o bearer local `utk_*` nunca é enviado a este transporte.
 * Os headers de modo (`x-uptokey-public-device`, `x-uptokey-ephemeral`) são
 * derivados pelo chamador a partir da política local efetiva, nunca de texto
 * de modelo. O corpo é sempre um envelope opaco; este módulo não cifra nem
 * decifra nada e não registra bytes, tokens ou envelopes.
 */
export type HostedKind = "sync" | "recovery";
export type HostedAccessTokenSource = (signal: AbortSignal) => Promise<string | undefined>;
export interface HostedMode { readonly publicDevice: boolean; readonly ephemeral: boolean }
export type HostedResponse =
  | { readonly ok: true; readonly status: number; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly status: number; readonly code: string; readonly currentVersion?: number };

export class HostedTransportUncertainError extends Error {
  readonly aborted: boolean;
  constructor(aborted: boolean) {
    super(aborted ? "hosted_request_aborted" : "hosted_network_uncertain");
    this.aborted = aborted;
    this.name = "HostedTransportUncertainError";
  }
}

const OBJECT_ID = /^[A-Za-z0-9_:-]{3,100}$/;
const MAX_RESPONSE_BYTES = 128 * 1024;

export function validateHostedOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("hosted_origin_invalid"); }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new Error("hosted_origin_invalid");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("hosted_origin_invalid");
  return url.origin;
}

export class HostedSyncClient {
  private readonly origin: string;
  private readonly accessToken: HostedAccessTokenSource | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly revalidate: ((signal:AbortSignal)=>Promise<void>) | undefined;

  constructor(options: { origin: string; accessToken?: HostedAccessTokenSource; fetchImpl?: typeof fetch; timeoutMs?: number; revalidate?:(signal:AbortSignal)=>Promise<void> }) {
    this.origin = validateHostedOrigin(options.origin);
    this.accessToken = options.accessToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.revalidate=options.revalidate;
  }

  availability(): { available: true } | { available: false; reason: "hosted_access_token_source_absent" } {
    return this.accessToken ? { available: true } : { available: false, reason: "hosted_access_token_source_absent" };
  }

  async request(kind: HostedKind, objectId: string, method: "GET" | "PUT" | "DELETE", body: unknown, mode: HostedMode, signal: AbortSignal): Promise<HostedResponse> {
    if (!OBJECT_ID.test(objectId)) return { ok: false, status: 400, code: "hosted_object_id_invalid" };
    if (!this.accessToken) return { ok: false, status: 503, code: "hosted_access_token_source_absent" };
    if (signal.aborted) throw new HostedTransportUncertainError(true);
    const token = await this.accessToken(signal);
    if (signal.aborted) throw new HostedTransportUncertainError(true);
    // Conta e bearer local são autoridades distintas: nunca reutilizar utk_.
    if (typeof token !== "string" || token.length < 8 || token.length > 16_000 || /\s/.test(token) || /^utk_/i.test(token)) {
      return { ok: false, status: 401, code: "hosted_account_token_unavailable" };
    }
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: "application/json" };
    if (mode.publicDevice) headers["x-uptokey-public-device"] = "1";
    if (mode.ephemeral) headers["x-uptokey-ephemeral"] = "1";
    if (body !== undefined) headers["content-type"] = "application/json";
    const path = kind === "sync" ? "/v1/hosted/sync/" : "/v1/hosted/recovery/";
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.origin}${path}${encodeURIComponent(objectId)}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: combined,
        redirect: "error",
        cache: "no-store",
      });
    } catch {
      // Requisição pode ter chegado ao servidor: resultado incerto, nunca "sincronizado".
      throw new HostedTransportUncertainError(signal.aborted);
    }
    let parsed: unknown;
    try {
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new Error("too_large");
      parsed = text.length ? JSON.parse(text) : {};
    } catch {
      if (response.ok) throw new HostedTransportUncertainError(signal.aborted);
      parsed = {};
    }
    // A result is not authority: native account expiry/revocation during IO must
    // be observed before the consumer confirms or persists this remote effect.
    await this.revalidate?.(signal);
    if(signal.aborted)throw new HostedTransportUncertainError(true);
    const record = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    if (response.ok) return { ok: true, status: response.status, body: record };
    const error = record.error && typeof record.error === "object" ? record.error as Record<string, unknown> : {};
    const code = typeof error.type === "string" && /^[a-z0-9_]{1,80}$/.test(error.type) ? error.type : `hosted_http_${response.status}`;
    const currentVersion = typeof error.currentVersion === "number" && Number.isSafeInteger(error.currentVersion) ? error.currentVersion : undefined;
    return { ok: false, status: response.status, code, ...(currentVersion !== undefined ? { currentVersion } : {}) };
  }
}

/** Composição produtiva: só existe transporte quando a origem é declarada. */
export function hostedSyncClientFromEnvironment(env: NodeJS.ProcessEnv = process.env, accessToken?: HostedAccessTokenSource, revalidate?:(signal:AbortSignal)=>Promise<void>): HostedSyncClient | undefined {
  const origin = env.UPTOKEY_HOSTED_SYNC_ORIGIN;
  if (!origin) return undefined;
  try { return new HostedSyncClient({ origin, ...(accessToken ? { accessToken } : {}),...(revalidate?{revalidate}:{}) }); } catch { return undefined; }
}
