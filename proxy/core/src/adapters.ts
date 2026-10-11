import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { DispatchOptions } from "./types.ts";
import { inferenceFetch } from "./streaming-transport.ts";
import { byteChunks, byteStream } from "./portable-streams.ts";

export async function dispatchFetch(
  url: string,
  init: RequestInit,
  options?: DispatchOptions,
  streaming = false,
): Promise<Response> {
  const originHeaders = new Headers(init.headers);
  if (originHeaders.has("proxy-authorization")) {
    originHeaders.delete("proxy-authorization");
    init = { ...init, headers: originHeaders };
  }
  if (!options?.proxyEndpoint || options?.usedDirect) {
    return await inferenceFetch(url, init, streaming);
  }

  const targetUrl = new URL(url);
  const proxyUrl = new URL(options.proxyEndpoint);
  if (!["http:", "https:"].includes(proxyUrl.protocol) || !["http:", "https:"].includes(targetUrl.protocol)) throw new Error("proxy_protocol_unsupported");
  const proxyRequest = proxyUrl.protocol === "https:" ? https.request : http.request;
  // Reuse the Fetch serializer for multipart boundaries, binary and stream bodies.
  const outgoing = new Request(url, { ...init, duplex: "half" } as RequestInit);
  const method = outgoing.method;
  const headersRecord = Object.fromEntries(outgoing.headers.entries());
  targetUrl.hash = "";

  return new Promise<Response>((resolve, reject) => {
    if (init.signal?.aborted) {
      return reject(new Error("aborted"));
    }
    let req: http.ClientRequest|undefined;
    let connectReq:http.ClientRequest|undefined;
    let tunnel:import('node:net').Socket|undefined;
    const onAbort = () => {
      req?.destroy(new Error("aborted"));
      connectReq?.destroy(new Error('aborted'));
      tunnel?.destroy(new Error('aborted'));
      reject(new Error("aborted"));
    };
    init.signal?.addEventListener("abort", onAbort, { once: true });

    function sendBody(request: http.ClientRequest) {
      if (outgoing.body) {
        const source = Readable.from(byteChunks(outgoing.body.getReader()));
        void pipeline(source, request).catch(reject);
      } else request.end();
    }
    function receiveResponse(response: http.IncomingMessage) {
      response.once("close", () => init.signal?.removeEventListener("abort", onAbort));
      try {
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) for (const item of value) headers.append(name, item);
          else if (value !== undefined) headers.set(name, value);
        }
        const status = response.statusCode ?? 200;
        const bodyless = method === "HEAD" || [204, 205, 304].includes(status);
        const result = new Response(bodyless ? null : byteStream(Readable.toWeb(response).getReader()), { status, statusText: response.statusMessage ?? "", headers });
        if (bodyless) response.resume();
        resolve(result);
      } catch (error) { response.destroy(); reject(error); }
    }


    if (targetUrl.protocol === "http:") {
      const proxyPort = Number(proxyUrl.port) || (proxyUrl.protocol === "https:" ? 443 : 80);
      req = proxyRequest(
        {
          host: proxyUrl.hostname,
          port: proxyPort,
          method,
          path: targetUrl.href,
          headers: {
            ...headersRecord,
            host: targetUrl.host,
            ...(options.proxyAuthorization ? { "proxy-authorization": options.proxyAuthorization } : {}),
          },
        },
        receiveResponse
      );

      req.on("error", (err) => { 
        init.signal?.removeEventListener("abort", onAbort);
        reject(err);
      });

      sendBody(req);
    } else {
      const proxyPort = Number(proxyUrl.port) || (proxyUrl.protocol === "https:" ? 443 : 80);
      const targetPort = Number(targetUrl.port) || 443;

      connectReq = proxyRequest({
        host: proxyUrl.hostname,
        port: proxyPort,
        method: "CONNECT",
        path: `${targetUrl.hostname}:${targetPort}`,
        headers: {
          Host: `${targetUrl.hostname}:${targetPort}`,
          ...(options.proxyAuthorization ? { "proxy-authorization": options.proxyAuthorization } : {}),
        },
      });

      connectReq.on("connect", (res, socket, _head) => {
        tunnel=socket;
        if(init.signal?.aborted){socket.destroy();return reject(new Error('aborted'));}
        if (res.statusCode !== 200) {
          socket.destroy();
          init.signal?.removeEventListener("abort", onAbort);
          return reject(new Error(`proxy_connect_failed: ${res.statusCode}`));
        }

        const tlsSocket = tls.connect({
          socket,
          servername: targetUrl.hostname,
          rejectUnauthorized: true,
        });
        tunnel=tlsSocket;

        tlsSocket.on("error", (err) => {
          init.signal?.removeEventListener("abort", onAbort);
          reject(err);
        });

        req = https.request(
          {
            host: targetUrl.hostname,
            port: targetPort,
            path: targetUrl.pathname + targetUrl.search,
            method,
            headers: {
              ...headersRecord,
              host: targetUrl.host,
            },
            createConnection: () => tlsSocket,
          },
          receiveResponse
        );

        req.on("error", (err) => {
          init.signal?.removeEventListener("abort", onAbort);
          reject(err);
        });

        sendBody(req);
      });

      connectReq.on("error", (err) => { 
        init.signal?.removeEventListener("abort", onAbort);
        reject(err);
      });

      connectReq.end();
    }
  });
}

import type { ChatCompletionRequest, ProviderAdapter, ProviderName } from "./types.ts";
import { createDeadline } from "./deadline.ts";
import { anthropicResponseToChatCompletion, anthropicSseToOpenAiSse, chatCompletionToAnthropicRequest } from "./anthropic-messages.ts";

export class GroqAdapter implements ProviderAdapter {
  readonly name = "groq" as const;
  async dispatch(request: ChatCompletionRequest, apiKey: string, signal: AbortSignal, requestTimeoutMs = 60_000, options?: DispatchOptions): Promise<Response> {
    const deadline = createDeadline(requestTimeoutMs);
    try {
      return await dispatchFetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST", signal: AbortSignal.any([signal, deadline.signal]), redirect: "error",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(request)
      }, options, request.stream === true);
    } finally { deadline.clear(); }
  }
}

export class GeminiAdapter implements ProviderAdapter {
  readonly name = "gemini" as const;
  async dispatch(request: ChatCompletionRequest, apiKey: string, signal: AbortSignal, requestTimeoutMs = 60_000, options?: DispatchOptions): Promise<Response> {
    const deadline = createDeadline(requestTimeoutMs);
    try {
      return await dispatchFetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
        method: "POST", signal: AbortSignal.any([signal, deadline.signal]), redirect: "error",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(request)
      }, options, request.stream === true);
    } finally { deadline.clear(); }
  }
}

export class GenericOpenAIAdapter implements ProviderAdapter {
  readonly name: ProviderName | string;
  private readonly endpoint: string | (() => string);
  readonly defaultHeaders: Record<string, string>;

  constructor(name: ProviderName | string, endpointUrl: string | (() => string), defaultHeaders: Record<string, string> = {}) {
    this.name = name;
    this.endpoint = endpointUrl;
    this.defaultHeaders = defaultHeaders;
  }

  get endpointUrl(): string { return typeof this.endpoint === "function" ? this.endpoint() : this.endpoint; }

  async dispatch(request: ChatCompletionRequest, apiKey: string, signal: AbortSignal, requestTimeoutMs = 60_000, options?: DispatchOptions): Promise<Response> {
    const deadline = createDeadline(requestTimeoutMs);
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        ...this.defaultHeaders
      };
      if (apiKey) {
        headers["authorization"] = `Bearer ${apiKey}`;
      }
      return await dispatchFetch(this.endpointUrl, {
        method: "POST",
        signal: AbortSignal.any([signal, deadline.signal]),
        redirect: "error",
        headers,
        body: JSON.stringify(request)
      }, options, request.stream === true);
    } finally {
      deadline.clear();
    }
  }
}

export class DeepSeekAdapter extends GenericOpenAIAdapter {
  constructor(endpointUrl: string | (() => string) = "https://api.deepseek.com/chat/completions") {
    super("deepseek", endpointUrl);
  }
}

export class OllamaAdapter extends GenericOpenAIAdapter {
  constructor(endpointUrl: string | (() => string) = "http://127.0.0.1:11434/v1/chat/completions") {
    super("ollama", endpointUrl);
  }
}

export class VllmAdapter extends GenericOpenAIAdapter {
  constructor(endpointUrl: string | (() => string) = "http://127.0.0.1:8000/v1/chat/completions") {
    super("vllm", endpointUrl);
  }
}

export class TogetherAdapter extends GenericOpenAIAdapter {
  constructor(endpointUrl: string | (() => string) = "https://api.together.xyz/v1/chat/completions") {
    super("together", endpointUrl);
  }
}

export class CerebrasAdapter extends GenericOpenAIAdapter {
  constructor(endpointUrl: string | (() => string) = "https://api.cerebras.ai/v1/chat/completions") {
    super("cerebras", endpointUrl);
  }
}

export class MistralAdapter extends GenericOpenAIAdapter {
  constructor(endpointUrl: string | (() => string) = "https://api.mistral.ai/v1/chat/completions") {
    super("mistral", endpointUrl);
  }
}

export class OpenRouterAdapter extends GenericOpenAIAdapter {
  constructor(endpointUrl: string | (() => string) = "https://openrouter.ai/api/v1/chat/completions") {
    super("openrouter", endpointUrl, {
      "HTTP-Referer": "https://uptokey.com",
      "X-Title": "Uptokey"
    });
  }
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly name = "anthropic" as const;
  private readonly endpoint: string | (() => string);

  constructor(endpointUrl: string | (() => string) = "https://api.anthropic.com/v1/messages") {
    this.endpoint = endpointUrl;
  }

  get endpointUrl(): string { return typeof this.endpoint === "function" ? this.endpoint() : this.endpoint; }

  /**
   * Exact Anthropic wire body dispatch() sends, including the prompt-cache control the
   * official endpoint admits. The router recounts this envelope with the selected Claude
   * model's own tokenizer instead of reusing an OpenAI-family count.
   */
  wireEnvelope(request: ChatCompletionRequest, options?: DispatchOptions): Record<string, unknown> {
    const body: Record<string, unknown> = chatCompletionToAnthropicRequest(request);
    if (options?.providerPromptCache && this.endpointUrl === 'https://api.anthropic.com/v1/messages') body.cache_control = { type: 'ephemeral' };
    return body;
  }

  async dispatch(request: ChatCompletionRequest, apiKey: string, signal: AbortSignal, requestTimeoutMs = 60_000, options?:DispatchOptions): Promise<Response> {
    const deadline = createDeadline(requestTimeoutMs);
    try {
      const upstream = await dispatchFetch(this.endpointUrl, {
        method: "POST",
        signal: AbortSignal.any([signal, deadline.signal]),
        redirect: "error",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify(this.wireEnvelope(request, options))
      }, options, request.stream === true);
      if (upstream.status !== 200) return upstream;
      const contentType = upstream.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (request.stream === true) {
        if (contentType !== "text/event-stream" || !upstream.body) return upstream;
        const headers = new Headers({ "content-type": "text/event-stream", "cache-control": "no-store" });
        for (const name of ["x-request-id", "request-id"]) {
          const value = upstream.headers.get(name);
          if (value) headers.set(name === "request-id" ? "x-provider-request-id" : name, value);
        }
        return new Response(anthropicSseToOpenAiSse(upstream.body), { status: 200, headers });
      }
      if (contentType !== "application/json") return upstream;
      const raw = await upstream.json();
      const converted = anthropicResponseToChatCompletion(raw);
      if (!converted) {
        return Response.json(
          { error: { type: "provider_response_invalid", message: "Anthropic response could not be converted." } },
          { status: 502, headers: { "content-type": "application/json", "cache-control": "no-store" } }
        );
      }
      const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
      for (const name of ["x-request-id", "request-id"]) {
        const value = upstream.headers.get(name);
        if (value) headers.set(name === "request-id" ? "x-provider-request-id" : name, value);
      }
      return new Response(JSON.stringify(converted), { status: 200, headers });
    } finally {
      deadline.clear();
    }
  }
}
