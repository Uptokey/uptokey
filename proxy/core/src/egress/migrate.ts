/**
 * Migrate legacy connection.proxyUrl (possibly with userinfo) into:
 * - EgressProxy metadata (endpoint without userinfo)
 * - vault credentialRef for userinfo (if present)
 * - ProxyBinding on the connection
 * Does NOT put secrets into backup/manifest.
 */
import { randomUUID } from "node:crypto";
import type { EgressStore } from "./store.ts";

export interface LegacyConnection {
  id: string;
  proxyUrl?: string | null;
  metadata?: Record<string, unknown>;
}

export async function migrateLegacyProxyUrls(opts: {
  connections: LegacyConnection[];
  store: Pick<EgressStore, "createProxy" | "createPool" | "setBinding" | "getBinding">;
  vaultSet: (ref: string, secret: string) => Promise<void>;
}): Promise<{
  migrated: Array<{ connectionId: string; proxyId: string; poolId: string; hadCredential: boolean }>;
  skipped: Array<{ connectionId: string; reason: string }>;
  errors: Array<{ connectionId: string; reason: string }>;
}> {
  const { connections, store, vaultSet } = opts;
  const report = {
    migrated: [] as Array<{ connectionId: string; proxyId: string; poolId: string; hadCredential: boolean }>,
    skipped: [] as Array<{ connectionId: string; reason: string }>,
    errors: [] as Array<{ connectionId: string; reason: string }>,
  };

  for (const conn of connections) {
    const raw = conn.proxyUrl;
    if (!raw || typeof raw !== "string" || !raw.trim()) {
      report.skipped.push({ connectionId: conn.id, reason: "no_legacy_proxy" });
      continue;
    }
    if (store.getBinding("connection", conn.id)?.poolId) {
      report.skipped.push({ connectionId: conn.id, reason: "already_bound" });
      continue;
    }
    try {
      const url = new URL(raw);
      let credentialRef: string | null = null;
      if (url.username || url.password) {
        credentialRef = `egress-proxy:${conn.id}`;
        await vaultSet(credentialRef, JSON.stringify({ username: url.username, password: url.password }));
        url.username = "";
        url.password = "";
      }
      const kind =
        url.protocol === "socks5:" || url.protocol === "socks:"
          ? "socks5"
          : url.protocol === "https:"
            ? "https"
            : "http";
      const proxy = await store.createProxy({
        id: randomUUID(),
        label: `migrated-${conn.id.slice(0, 8)}`,
        kind,
        endpointUrl: url.href,
        enabled: true,
        credentialRef,
        operatorLabel: "legacy-migration",
        retentionEvidence: null,
      });
      const pool = await store.createPool({
        memberIds: [proxy.id],
        strategy: "fixed",
        strict: false,
        allowDirectFallback: true,
        noProxy: [],
      });
      await store.setBinding({
        ownerKind: "connection",
        ownerId: conn.id,
        poolId: pool.id,
        inherit: false,
        expectedRevision: pool.revision,
      });
      report.migrated.push({
        connectionId: conn.id,
        proxyId: proxy.id,
        poolId: pool.id,
        hadCredential: Boolean(credentialRef),
      });
    } catch (err) {
      report.errors.push({
        connectionId: conn.id,
        reason: err instanceof Error ? err.message : "migrate_failed",
      });
    }
  }
  return report;
}
