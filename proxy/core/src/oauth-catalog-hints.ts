import type { OAuthConnectionMeta } from "./oauth-connection.ts";

/** Catalog/UI hints for etapa 05/13 — status only; never refresh tokens. */
export function projectOAuthCatalogHints(connections: OAuthConnectionMeta[]): Array<{
  connectionId: string;
  providerId: string;
  principalId: string;
  authMethod: "oauth";
  state: OAuthConnectionMeta["state"];
  scopesGranted: string[];
  accountLabel: string;
  expiresAt: string | null;
  revision: number;
}> {
  return connections.map((c) => ({
    connectionId: c.connectionId,
    providerId: c.providerId,
    principalId: c.principalId,
    authMethod: "oauth" as const,
    state: c.state,
    scopesGranted: [...c.scopes],
    accountLabel: c.accountLabel,
    expiresAt: c.expiresAt,
    revision: c.revision,
  }));
}
