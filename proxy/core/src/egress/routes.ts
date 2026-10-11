/**
 * E2-19 local HTTP routes under /local/egress/* and connection proxy-binding.
 * Wire via registerEgressRoutes(app, { store, requireLocalAuth }).
 * List endpoints never return credentialRef.
 */
import type { Context, Hono, Next } from "hono";
import { EGRESS_ERROR_CODES, projectEgressProxyPublic } from "@uptokey/sync-contract/egress";
import type { EgressStore } from "./store.ts";

type AuthMiddleware = (c: Context, next: Next) => Promise<Response | void>;

function sendError(c: Context, err: { code?: string; status?: number; impactedPoolIds?: string[]; impactedBindingIds?: string[] } | null) {
  const code = err?.code || "proxy_unavailable";
  const status = (err?.status || EGRESS_ERROR_CODES[code as keyof typeof EGRESS_ERROR_CODES] || 500) as 400 | 401 | 403 | 404 | 409 | 422 | 500 | 503;
  const body: { error: { type: string; message: string; impactedPoolIds?: string[]; impactedBindingIds?: string[] } } = {
    error: { type: code, message: code },
  };
  if (err?.impactedPoolIds) body.error.impactedPoolIds = err.impactedPoolIds;
  if (err?.impactedBindingIds) body.error.impactedBindingIds = err.impactedBindingIds;
  return c.json(body, status);
}

export const EGRESS_LOCAL_ROUTE_PREFIXES = [
  "/local/egress/proxies",
  "/local/egress/pools",
  "/local/egress/tests",
  "/local/egress/health/",
  "/local/connections/",
] as const;

/** Exact-map gate in app.ts only knows static paths — allow dynamic egress paths here. */
export function matchEgressLocalRoute(pathname: string, method: string): boolean {
  if (pathname === "/local/egress/proxies" && (method === "GET" || method === "POST")) return true;
  if (/^\/local\/egress\/proxies\/[^/]+$/.test(pathname) && (method === "PATCH" || method === "DELETE")) return true;
  if (pathname === "/local/egress/pools" && (method === "GET" || method === "POST")) return true;
  if (/^\/local\/egress\/pools\/[^/]+$/.test(pathname) && (method === "PATCH" || method === "DELETE")) return true;
  if (pathname === "/local/egress/tests" && method === "POST") return true;
  if (/^\/local\/egress\/tests\/[^/]+$/.test(pathname) && method === "GET") return true;
  if (/^\/local\/egress\/tests\/[^/]+\/cancel$/.test(pathname) && method === "POST") return true;
  if (/^\/local\/egress\/health\/[^/]+$/.test(pathname) && method === "GET") return true;
  if (/^\/local\/connections\/[^/]+\/proxy-binding$/.test(pathname) && (method === "GET" || method === "PATCH")) return true;
  return false;
}

export function registerEgressRoutes(
  app: Hono,
  deps: { store: EgressStore; requireLocalAuth: AuthMiddleware },
): void {
  const { store, requireLocalAuth } = deps;
  app.use("/local/egress/*", requireLocalAuth);
  app.use("/local/connections/*/proxy-binding", requireLocalAuth);

  app.get("/local/egress/proxies", (c) => c.json({ proxies: store.listProxiesPublic() }));

  app.post("/local/egress/proxies", async (c) => {
    try {
      const body = await c.req.json();
      const proxy = await store.createProxy(body);
      return c.json({ proxy: projectEgressProxyPublic(proxy) }, 201);
    } catch (err) {
      return sendError(c, err as { code?: string; status?: number });
    }
  });

  app.patch("/local/egress/proxies/:id", async (c) => {
    try {
      const body = await c.req.json();
      const proxy = await store.updateProxy(c.req.param("id"), body);
      return c.json({ proxy: projectEgressProxyPublic(proxy) });
    } catch (err) {
      return sendError(c, err as { code?: string; status?: number });
    }
  });

  app.delete("/local/egress/proxies/:id", async (c) => {
    try {
      await store.deleteProxy(c.req.param("id"));
      return c.json({ ok: true });
    } catch (err) {
      return sendError(c, err as { code?: string; status?: number });
    }
  });

  app.get("/local/egress/pools", (c) => c.json({ pools: store.listPools() }));

  app.post("/local/egress/pools", async (c) => {
    try {
      const body = await c.req.json();
      const pool = await store.createPool(body);
      return c.json({ pool }, 201);
    } catch (err) {
      return sendError(c, err as { code?: string; status?: number });
    }
  });

  app.patch("/local/egress/pools/:id", async (c) => {
    try {
      const body = await c.req.json();
      const pool = await store.updatePool(c.req.param("id"), body);
      return c.json({ pool });
    } catch (err) {
      return sendError(c, err as { code?: string; status?: number });
    }
  });

  app.delete("/local/egress/pools/:id", async (c) => {
    try {
      await store.deletePool(c.req.param("id"));
      return c.json({ ok: true });
    } catch (err) {
      return sendError(c, err as { code?: string; status?: number });
    }
  });

  app.patch("/local/connections/:id/proxy-binding", async (c) => {
    try {
      const body = await c.req.json();
      const binding = await store.setBinding({
        ownerKind: "connection",
        ownerId: c.req.param("id"),
        poolId: body.poolId ?? null,
        inherit: body.inherit ?? false,
        expectedRevision: body.expectedRevision,
      });
      return c.json({ binding });
    } catch (err) {
      return sendError(c, err as { code?: string; status?: number });
    }
  });

  app.get("/local/connections/:id/proxy-binding", (c) => {
    const binding = store.getBinding("connection", c.req.param("id"));
    return c.json({ binding: binding ?? null });
  });

  app.post("/local/egress/tests", async (c) => {
    try {
      const body = await c.req.json();
      const job = await store.createTestJob({
        memberIds: body.memberIds,
        approvedTargetId: body.approvedTargetId,
        operationId: body.operationId,
      });
      return c.json({ job }, 201);
    } catch (err) {
      return sendError(c, err as { code?: string; status?: number });
    }
  });

  app.get("/local/egress/tests/:jobId", (c) => {
    const job = store.getTestJob(c.req.param("jobId"));
    if (!job) return sendError(c, { code: "proxy_not_found", status: 404 });
    return c.json({ job });
  });

  app.post("/local/egress/tests/:jobId/cancel", async (c) => {
    try {
      const job = await store.cancelTestJob(c.req.param("jobId"));
      return c.json({ job });
    } catch (err) {
      return sendError(c, err as { code?: string; status?: number });
    }
  });

  app.get("/local/egress/health/:memberId", (c) => {
    const health = store.journal.health[c.req.param("memberId")] ?? null;
    return c.json({ health });
  });
}
