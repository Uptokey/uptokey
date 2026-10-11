import type { Dispatcher } from "undici";

const streamingDispatchers = new WeakMap<Dispatcher, Dispatcher>();

/** Keep the runtime's dispatcher/pools/TLS/proxy policy; override only the body
 * silence timer of a requested inference stream. Nothing changes globally.
 * Official contract: https://undici.nodejs.org/#/docs/api/Client (bodyTimeout=0).
 */
export async function inferenceFetch(input: string | URL, init: RequestInit, streaming: boolean): Promise<Response> {
  if (!streaming || typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") return fetch(input, init);
  const { getGlobalDispatcher } = await import("undici");
  const base = getGlobalDispatcher();
  let dispatcher = streamingDispatchers.get(base);
  if (!dispatcher) {
    dispatcher = base.compose((dispatch) => (options, handler) => dispatch({ ...options, bodyTimeout: 0 }, handler));
    streamingDispatchers.set(base, dispatcher);
  }
  const options: RequestInit & { dispatcher: Dispatcher } = { ...init, dispatcher };
  return fetch(input, options);
}

/** Bun applies socket idleness even to active SSE. Only a confirmed streaming
 * response opts out; ordinary routes and pre-response waits retain server limits.
 * https://bun.sh/docs/runtime/http/server#server-timeout-request-seconds
 */
export function streamingAwareHandler(handler: (request: Request) => Response | Promise<Response>) {
  return async (request: Request, server: { timeout(request: Request, seconds: number): void }): Promise<Response> => {
    const response = await handler(request);
    if (response.ok && response.body && response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === "text/event-stream") server.timeout(request, 0);
    return response;
  };
}
