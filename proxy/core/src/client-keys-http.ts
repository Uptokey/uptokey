// @ts-nocheck
import type { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { readBoundedJson, MAX_INFERENCE_REQUEST_BYTES, MAX_LOCAL_CONTROL_REQUEST_BYTES } from "@uptokey/sync-contract/limits";
import {
  parseLegacyCompletions, legacyToChatRequest, chatCompletionToTextCompletion,
  parseCountTokens, estimateTokensFor, sseErrorEnvelope
} from "./protocol-capability.ts";
import { releaseWithResponse } from "./request-admission.ts";
import { createClientKey, updateClientKey, rotateClientKey, revokeClientKey, listClientKeys } from "./client-keys.ts";

function hasExactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

export function mountClientAndManagementRoutes(app: Hono, deps: any) {
  const {
    config,
    secrets,
    identityEpoch,
    offlineGuard,
    inferenceAdmission,
    authRateLimiter,
    pairingRateLimiter,
    openRouterManagement,
    router,
    identityEpochMismatch,
    administrativeAuth,
    authorizeClientKeyManagement,
    projectInferenceRequest,
    requestClient,
    checkModelScope,
    checkOutputLimit,
    dispatchInference,
    processingScope,
    openAiChatSseToTextCompletionSse,
  } = deps;

  // E2-03 PROPOSTA agora implementada: compatibilidade adicional com parser/adapter
  // próprios. /v1/completions é superfície prompt-only; nunca alias que descarta campos.
  app.post("/v1/completions", async (c) => {
    const currentIdentity = identityEpoch?.();
    if (identityEpochMismatch(config, currentIdentity)) return c.json({ error: { type: "config_epoch_pending", message: "Aguardando aplicar a configuração autenticada deste device. As chaves locais foram preservadas." } }, 503);
    const offline = await offlineGuard(new Date());
    if (!offline.allowed) return c.json({ error: { type: offline.code, message: "Reconecte o proxy ao control plane para revalidar o acesso." } }, 503);
    const release = inferenceAdmission.tryAcquire();
    if (!release) {
      c.header("Retry-After", "1");
      return c.json({ error: { type: "local_capacity_exceeded" } }, 429);
    }
    try {
      const parsed = await readBoundedJson(c.req.raw, MAX_INFERENCE_REQUEST_BYTES);
      if (!parsed.ok) { release(); return c.json({ error: { type: parsed.reason === "too_large" ? "inference_request_too_large" : "invalid_request" } }, parsed.reason === "too_large" ? 413 : 400); }
      const privacyScope = await processingScope(c, parsed.value);
      if (privacyScope instanceof Response) { release(); return privacyScope; }
      const legacy = parseLegacyCompletions(parsed.value);
      if ("error" in legacy) {
        release();
        if (legacy.error === "protocol_field_unsupported") return c.json({ error: { type: "protocol_field_unsupported", field: legacy.field } }, 422);
        return c.json({ error: { type: "invalid_request", message: "schema de Completions inválido" } }, 400);
      }
      const request = legacyToChatRequest(legacy);
      const projected = projectInferenceRequest(request);
      if (!projected) { release(); return c.json({ error: { type: "invalid_request", message: "schema de Completions inválido" } }, 400); }
      const client = requestClient(c);
      const modelDenied = checkModelScope(client, legacy.model);
      if (modelDenied) { release(); return c.json({ error: { type: "model_scope_denied" } }, 403); }
      const limitDenied = checkOutputLimit(client, legacy.max_tokens);
      if (limitDenied) { release(); return c.json({ error: { type: "key_limit_exceeded" } }, 429); }
      const cacheTenantId = currentIdentity?.tenantId ?? config.appliedConfigTenantId;
      const response = await dispatchInference(router, projected, { requestId: randomUUID(), ...(cacheTenantId ? { tenantId: cacheTenantId } : {}), ...privacyScope }, c.req.raw.signal);
      if (response.status !== 200) return releaseWithResponse(response, release, c.req.raw.signal);
      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (projected.stream === true && contentType === "text/event-stream") {
        if (!response.body) { release(); return c.json({ error: { type: "provider_response_invalid" } }, 502); }
        const headers = new Headers({ "content-type": "text/event-stream", "cache-control": "no-store" });
        for (const name of ["x-uptokey-provider", "x-uptokey-model", "x-uptokey-fallback", "x-uptokey-cache", "x-request-id", "x-provider-request-id"]) {
          const value = response.headers.get(name);
          if (value) headers.set(name, value);
        }
        const out = new Response(openAiChatSseToTextCompletionSse(response.body), { status: 200, headers });
        return releaseWithResponse(out, release, c.req.raw.signal);
      }
      if (projected.stream === true || contentType !== "application/json") {
        await response.body?.cancel().catch(() => undefined);
        release(); return c.json({ error: { type: 'provider_response_invalid' } }, 502);
      }
      let openaiBody: unknown;
      try {
        openaiBody = await response.json();
      } catch {
        release();
        return c.json({ error: { type: "upstream_protocol_invalid" } }, 502);
      }
      const completion = chatCompletionToTextCompletion(openaiBody);
      if (!completion) {
        release();
        return c.json({ error: { type: "provider_response_invalid" } }, 502);
      }
      const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
      for (const name of ["x-uptokey-provider", "x-uptokey-model", "x-uptokey-fallback", "x-uptokey-cache", "x-request-id", "x-provider-request-id"]) {
        const value = response.headers.get(name);
        if (value) headers.set(name, value);
      }
      const out = new Response(JSON.stringify(completion), { status: 200, headers });
      return releaseWithResponse(out, release, c.req.raw.signal);
    } catch (error) { release(); throw error; }
  });

  // E2-03: contagem local é estimativa identificada; nunca se apresenta como oficial.
  app.post("/v1/messages/count_tokens", async (c) => {
    const parsed = await readBoundedJson(c.req.raw, MAX_LOCAL_CONTROL_REQUEST_BYTES);
    if (!parsed.ok) return c.json({ error: { type: parsed.reason === "too_large" ? "request_too_large" : "invalid_request" } }, parsed.reason === "too_large" ? 413 : 400);
    const input = parseCountTokens(parsed.value);
    if ("error" in input) {
      if (input.error === "protocol_field_unsupported") return c.json({ error: { type: "protocol_field_unsupported", field: input.field } }, 422);
      return c.json({ error: { type: "invalid_request", message: "schema de count_tokens inválido" } }, 400);
    }
    return c.json(estimateTokensFor(input.messageText, input.model));
  });

  // Local key management also accepts the application's authenticated unrestricted
  // browser enrollment. Origin alone never grants credential authority.
  async function requireKeyAdmin(c: { req: { header: (name: string) => string | undefined } }, secretsRef: SecretStore): Promise<true | { rateLimited: boolean; retryAfterSeconds: number }> {
    const mutationAuth = typeof authorizeClientKeyManagement === "function"
      ? await authorizeClientKeyManagement(c.req.header("origin"), c.req.header("authorization"), secretsRef, authRateLimiter)
      : await administrativeAuth(c.req.header("authorization"), secretsRef, authRateLimiter);
    if (mutationAuth.allowed) return true;
    return { rateLimited: mutationAuth.rateLimited, retryAfterSeconds: mutationAuth.retryAfterSeconds };
  }

  function keyErrorToResponse(c: { json: (body: unknown, status: number) => Response }, error: unknown): Response {
    const message = error instanceof Error ? error.message : "";
    if (message === "key_not_found") return c.json({ error: { type: "key_not_found" } }, 404);
    if (message === "key_conflict") return c.json({ error: { type: "key_conflict" } }, 409);
    if (message === "key_capacity_exceeded") {
      (c as unknown as { header: (n: string, v: string) => void }).header("Retry-After", "300");
      return c.json({ error: { type: "key_capacity_exceeded" } }, 429);
    }
    if (message === "client_key_invalid" || message === "client_key_version_unsupported") return c.json({ error: { type: "invalid_request" } }, 400);
    throw error;
  }

  app.get("/local/client-keys", async (c) => {
    const admin = await requireKeyAdmin(c, secrets);
    if (admin !== true) {
      if (admin.rateLimited) { c.header("Retry-After", String(admin.retryAfterSeconds)); return c.json({ error: { type: "local_auth_rate_limited" } }, 429); }
      return c.json({ error: { type: "unauthorized" } }, 401);
    }
    const url = new URL(c.req.url);
    const limit = url.searchParams.get("limit") === null ? 100 : Number(url.searchParams.get("limit"));
    const cursor = url.searchParams.get("cursor") ?? undefined;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return c.json({ error: { type: "invalid_request" } }, 400);
    if (cursor !== undefined && !/^[0-9a-f-]{36}$/i.test(cursor)) return c.json({ error: { type: "invalid_request" } }, 400);
    return c.json(await listClientKeys(secrets, limit, cursor));
  });

  app.post("/local/client-keys", async (c) => {
    const admin = await requireKeyAdmin(c, secrets);
    if (admin !== true) {
      if (admin.rateLimited) { c.header("Retry-After", String(admin.retryAfterSeconds)); return c.json({ error: { type: "local_auth_rate_limited" } }, 429); }
      return c.json({ error: { type: "unauthorized" } }, 401);
    }
    const rate = pairingRateLimiter.take("localhost-client-keys-mutate", 20, 60_000);
    if (!rate.ok) { c.header("Retry-After", String(rate.retryAfter)); return c.json({ error: { type: "local_provider_rate_limited" } }, 429); }
    const parsed = await readBoundedJson(c.req.raw, MAX_LOCAL_CONTROL_REQUEST_BYTES);
    if (!parsed.ok) return c.json({ error: { type: "invalid_request" } }, 400);
    try {
      const body = parsed.value as Record<string, unknown>;
      const allowed = ["label", "scopes", "projectIds", "providerIds", "modelIds", "expiresAt", "limits", "operationId", "principalId", "retentionMode"];
      if (Object.keys(body).some((k) => !allowed.includes(k))) return c.json({ error: { type: "invalid_request" } }, 400);
      if (typeof body.operationId !== "string") return c.json({ error: { type: "invalid_request" } }, 400);
      const { policy, view, token } = await createClientKey(secrets, {
        label: String(body.label ?? ""),
        scopes: (Array.isArray(body.scopes) ? body.scopes : []) as never,
        projectIds: (Array.isArray(body.projectIds) ? body.projectIds : []) as string[],
        providerIds: (Array.isArray(body.providerIds) ? body.providerIds : []) as string[],
        modelIds: (Array.isArray(body.modelIds) ? body.modelIds : []) as string[],
        expiresAt: (body.expiresAt ?? null) as string | null,
        limits: (body.limits ?? undefined) as never,
        operationId: body.operationId as string,
        principalId: typeof body.principalId === "string" ? body.principalId : "local",
        ...(body.retentionMode !== undefined ? { retentionMode: body.retentionMode as "standard" | "ephemeral" } : {}),
      });
      void policy;
      return c.json({ ...view, token }, 201);
    } catch (error) {
      if (error instanceof Error && ["client_key_invalid", "client_key_version_unsupported", "key_capacity_exceeded", "key_conflict"].includes(error.message)) {
        return keyErrorToResponse(c, error);
      }
      return c.json({ error: { type: "invalid_request" } }, 400);
    }
  });

  app.all("/local/client-keys/:id", async (c) => {
    if (c.req.method !== "PATCH") { c.header("Allow", "PATCH"); return c.json({ error: { type: "method_not_allowed" } }, 405); }
    const admin = await requireKeyAdmin(c, secrets);
    if (admin !== true) {
      if (admin.rateLimited) { c.header("Retry-After", String(admin.retryAfterSeconds)); return c.json({ error: { type: "local_auth_rate_limited" } }, 429); }
      return c.json({ error: { type: "unauthorized" } }, 401);
    }
    const id = c.req.param("id");
    const parsed = await readBoundedJson(c.req.raw, MAX_LOCAL_CONTROL_REQUEST_BYTES);
    if (!parsed.ok) return c.json({ error: { type: "invalid_request" } }, 400);
    try {
      const body = parsed.value as Record<string, unknown>;
      const allowed = ["expectedRevision", "operationId", "label", "projectIds", "providerIds", "modelIds", "scopes", "expiresAt", "enabled", "limits", "retentionMode"];
      if (Object.keys(body).some((k) => !allowed.includes(k)) || !Number.isSafeInteger(body.expectedRevision) || typeof body.operationId !== "string") {
        return c.json({ error: { type: "invalid_request" } }, 400);
      }
      return c.json(await updateClientKey(secrets, id, body as never));
    } catch (error) {
      if (error instanceof Error && ["key_not_found", "key_conflict", "client_key_invalid", "client_key_version_unsupported"].includes(error.message)) {
        return keyErrorToResponse(c, error);
      }
      return c.json({ error: { type: "invalid_request" } }, 400);
    }
  });

  for (const action of ["rotate", "revoke"] as const) app.post(`/local/client-keys/:id/${action}`, async (c) => {
    const admin = await requireKeyAdmin(c, secrets);
    if (admin !== true) {
      if (admin.rateLimited) { c.header("Retry-After", String(admin.retryAfterSeconds)); return c.json({ error: { type: "local_auth_rate_limited" } }, 429); }
      return c.json({ error: { type: "unauthorized" } }, 401);
    }
    const id = c.req.param("id");
    const parsed = await readBoundedJson(c.req.raw, MAX_LOCAL_CONTROL_REQUEST_BYTES);
    if (!parsed.ok || !hasExactKeys(parsed.value, ["expectedRevision", "operationId"]) || !Number.isSafeInteger(parsed.value.expectedRevision) || typeof parsed.value.operationId !== "string") {
      return c.json({ error: { type: "invalid_request" } }, 400);
    }
    try {
      if (action === "rotate") {
        const { view, token } = await rotateClientKey(secrets, id, parsed.value.expectedRevision as number, parsed.value.operationId as string);
        return c.json({ ...view, token });
      }
      return c.json(await revokeClientKey(secrets, id, parsed.value.expectedRevision as number, parsed.value.operationId as string));
    } catch (error) {
      if (error instanceof Error && ["key_not_found", "key_conflict", "client_rotation_rollback_failed"].includes(error.message)) {
        if (error.message === "client_rotation_rollback_failed") return c.json({ error: { type: "key_rotation_failed" } }, 503);
        return keyErrorToResponse(c, error);
      }
      throw error;
    }
  });

  // E2-03: gestão remota OpenRouter via chave oficial no cofre local. Nunca usa a
  // chave de gestão para inferência; nunca expõe BYOK como token de cliente.
  app.post("/local/openrouter/management/config", async (c) => {
    const admin = await requireKeyAdmin(c, secrets);
    if (admin !== true) {
      if (admin.rateLimited) { c.header("Retry-After", String(admin.retryAfterSeconds)); return c.json({ error: { type: "local_auth_rate_limited" } }, 429); }
      return c.json({ error: { type: "unauthorized" } }, 401);
    }
    const parsed = await readBoundedJson(c.req.raw, MAX_LOCAL_CONTROL_REQUEST_BYTES);
    if (!parsed.ok || !hasExactKeys(parsed.value, ["key"]) || typeof parsed.value.key !== "string") return c.json({ error: { type: "invalid_request" } }, 400);
    try {
      await openRouterManagement.configureManagementKey(parsed.value.key as string);
    } catch {
      return c.json({ error: { type: "invalid_request" } }, 400);
    }
    return c.body(null, 204);
  });

  app.all("/local/openrouter/management/config", async (c) => {
    if (c.req.method !== "DELETE") { c.header("Allow", "POST, DELETE"); return c.json({ error: { type: "method_not_allowed" } }, 405); }
    const admin = await requireKeyAdmin(c, secrets);
    if (admin !== true) {
      if (admin.rateLimited) { c.header("Retry-After", String(admin.retryAfterSeconds)); return c.json({ error: { type: "local_auth_rate_limited" } }, 429); }
      return c.json({ error: { type: "unauthorized" } }, 401);
    }
    if (c.req.raw.body !== null || c.req.header("content-type") !== undefined) return c.json({ error: { type: "invalid_request" } }, 400);
    await openRouterManagement.clearManagementKey();
    return c.body(null, 204);
  });

  app.get("/local/openrouter/credits", async (c) => {
    const admin = await requireKeyAdmin(c, secrets);
    if (admin !== true) {
      if (admin.rateLimited) { c.header("Retry-After", String(admin.retryAfterSeconds)); return c.json({ error: { type: "local_auth_rate_limited" } }, 429); }
      return c.json({ error: { type: "unauthorized" } }, 401);
    }
    try {
      // E2-21-B: provider-reported OpenRouter balance; management key never leaves this device.
      return c.json(await openRouterManagement.readCredits());
    } catch (error) {
      return openRouterErrorToResponse(c, error);
    }
  });

  app.get("/local/openrouter/management/keys", async (c) => {
    const admin = await requireKeyAdmin(c, secrets);
    if (admin !== true) {
      if (admin.rateLimited) { c.header("Retry-After", String(admin.retryAfterSeconds)); return c.json({ error: { type: "local_auth_rate_limited" } }, 429); }
      return c.json({ error: { type: "unauthorized" } }, 401);
    }
    const operationId = new URL(c.req.url).searchParams.get("operationId");
    if (!operationId) return c.json({ error: { type: "invalid_request" } }, 400);
    try {
      return c.json(await openRouterManagement.execute({ kind: "list", operationId }));
    } catch (error) {
      return openRouterErrorToResponse(c, error);
    }
  });

  app.post("/local/openrouter/management/keys", async (c) => {
    const admin = await requireKeyAdmin(c, secrets);
    if (admin !== true) {
      if (admin.rateLimited) { c.header("Retry-After", String(admin.retryAfterSeconds)); return c.json({ error: { type: "local_auth_rate_limited" } }, 429); }
      return c.json({ error: { type: "unauthorized" } }, 401);
    }
    const parsed = await readBoundedJson(c.req.raw, MAX_LOCAL_CONTROL_REQUEST_BYTES);
    if (!parsed.ok) return c.json({ error: { type: "invalid_request" } }, 400);
    try {
      const body = parsed.value as Record<string, unknown>;
      const result = await openRouterManagement.execute({ kind: "create", ...(body as unknown as Record<string, unknown>) } as never);
      return c.json(result, 201);
    } catch (error) {
      return openRouterErrorToResponse(c, error);
    }
  });

  app.all("/local/openrouter/management/keys/:hash", async (c) => {
    const admin = await requireKeyAdmin(c, secrets);
    if (admin !== true) {
      if (admin.rateLimited) { c.header("Retry-After", String(admin.retryAfterSeconds)); return c.json({ error: { type: "local_auth_rate_limited" } }, 429); }
      return c.json({ error: { type: "unauthorized" } }, 401);
    }
    const hash = c.req.param("hash");
    try {
      if (c.req.method === "GET") {
        const operationId = new URL(c.req.url).searchParams.get("operationId");
        if (!operationId) return c.json({ error: { type: "invalid_request" } }, 400);
        return c.json(await openRouterManagement.execute({ kind: "get", operationId, remoteKeyHash: hash }));
      }
      const parsed = await readBoundedJson(c.req.raw, MAX_LOCAL_CONTROL_REQUEST_BYTES);
      if (!parsed.ok) return c.json({ error: { type: "invalid_request" } }, 400);
      const body = parsed.value as Record<string, unknown>;
      if (c.req.method === "PATCH") {
        if (typeof body.operationId !== "string") return c.json({ error: { type: "invalid_request" } }, 400);
        const keys = Object.keys(body);
        // disable explícito via {operationId, disabled:true} sem outros campos.
        if (keys.length === 2 && keys.includes("operationId") && keys.includes("disabled") && body.disabled === true) {
          return c.json(await openRouterManagement.execute({ kind: "disable", operationId: body.operationId as string, remoteKeyHash: hash }));
        }
        return c.json(await openRouterManagement.execute({ kind: "update", remoteKeyHash: hash, ...(body as unknown as Record<string, unknown>) } as never));
      }
      if (c.req.method === "DELETE") {
        if (!hasExactKeys(parsed.value, ["operationId"]) || typeof body.operationId !== "string") return c.json({ error: { type: "invalid_request" } }, 400);
        const result = await openRouterManagement.execute({ kind: "delete", operationId: body.operationId as string, remoteKeyHash: hash });
        return c.json(result);
      }
      c.header("Allow", "GET, PATCH, DELETE");
      return c.json({ error: { type: "method_not_allowed" } }, 405);
    } catch (error) {
      return openRouterErrorToResponse(c, error);
    }
  });

  function openRouterErrorToResponse(c: { json: (body: unknown, status: number) => Response; header: (n: string, v: string) => void }, error: unknown): Response {
    const message = error instanceof Error ? error.message : "";
    if (message === "management_key_required") return c.json({ error: { type: "management_key_required" } }, 403);
    if (message === "management_key_invalid") return c.json({ error: { type: "management_key_invalid" } }, 403);
    // Provider 403: the stored key is not a management key — same gate, no balance leaked.
    if (message === "management_key_forbidden") return c.json({ error: { type: "management_key_required" } }, 403);
    if (message === "management_key_command_invalid") return c.json({ error: { type: "invalid_request" } }, 400);
    if (message === "key_not_found") return c.json({ error: { type: "key_not_found" } }, 404);
    if (message === "key_limit_exceeded") {
      c.header("Retry-After", "60");
      return c.json({ error: { type: "key_limit_exceeded" } }, 429);
    }
    if (message === "upstream_protocol_invalid") return c.json({ error: { type: "upstream_protocol_invalid" } }, 502);
    if (message === "upstream_unreachable") return c.json({ error: { type: "upstream_unreachable" } }, 502);
    throw error;
  }


}
