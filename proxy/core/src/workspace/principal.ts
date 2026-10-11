import { createHash } from 'node:crypto';
import type { SecretStore } from '../secret-store.ts';
import { resolveBearer } from '../client-keys.ts';
import { credentialProjectGrant, resolveClientContextLink } from './client-context-link.ts';
import { canonicalJson } from '@uptokey/sync-contract/canonical';

/** Server-derived intersection; [] grants no project, '*' preserves unrestricted owners. */
export type LocalProjectGrant = '*' | readonly string[];
/** Retention comes only from the authenticated, server-owned credential policy. */
export async function resolveLocalRetentionMode(header: string | undefined, secrets: SecretStore): Promise<'standard' | 'ephemeral' | undefined> {
  const token = /^Bearer (\S+)$/i.exec(header ?? '')?.[1];
  const result = await resolveBearer(secrets, token);
  if (!result.ok || result.resolved.delegation) return;
  return result.resolved.policy?.retentionMode ?? 'standard';
}
export function isProjectGranted(grant: LocalProjectGrant, projectId: unknown): boolean {
  return grant === '*' || (typeof projectId === 'string' && grant.includes(projectId));
}
export async function resolveLocalProjectGrant(header: string | undefined, secrets: SecretStore, epoch: IdentityEpoch = undefined): Promise<LocalProjectGrant | undefined> {
  return (await resolveLocalWorkspaceAuthority(header,secrets,epoch))?.projects;
}

export type IdentityEpoch = { tenantId: string; deviceId: string } | undefined;
const CLIENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const namespace = (epoch: IdentityEpoch) => createHash('sha256').update(JSON.stringify(epoch ? [epoch.tenantId, epoch.deviceId] : ['local'])).digest('hex').slice(0, 24);
/** Canonical workspace principal id for an authenticated, non-delegated local credential. */
export function localPrincipalId(epoch: IdentityEpoch, client: { kind: 'admin' | 'client'; clientId?: string }): string {
  return `${namespace(epoch)}_${client.kind === 'admin' ? 'admin' : client.clientId}`;
}
/** Current server authority for generation-cache reuse; never a credential or a grant from request JSON. */
export async function resolveLocalCacheAuthority(header: string | undefined, secrets: SecretStore, epoch: IdentityEpoch): Promise<{principal: string; partition: string; projects: LocalProjectGrant} | undefined> {
  const token = /^Bearer (\S+)$/i.exec(header ?? '')?.[1];
  const result = await resolveBearer(secrets, token);
  if (!result.ok || result.resolved.delegation || result.resolved.policy?.retentionMode === 'ephemeral') return;
  const client = result.resolved;
  const link = await resolveClientContextLink(secrets,client,epoch);
  const projects: LocalProjectGrant = link ? Object.freeze([link.projectId]) : credentialProjectGrant(client);
  const principal = link?.ownerPrincipalId ?? localPrincipalId(epoch,client);
  const partition = createHash('sha256').update(canonicalJson({version: 1, principal, policy: client.policy ?? null, registration: client.registration ?? null,
    ...(link ? {context:{clientId:client.clientId,revision:link.revision,projectId:link.projectId}} : {})})).digest('hex');
  return {principal, partition, projects};
}
export async function resolveLocalPrincipal(header: string | undefined, secrets: SecretStore, epoch: IdentityEpoch): Promise<string | undefined> {
  return (await resolveLocalWorkspaceAuthority(header,secrets,epoch))?.principal;
}
/** Resolve data owner and finite scope from one fresh credential/link snapshot. */
export async function resolveLocalWorkspaceAuthority(header: string | undefined, secrets: SecretStore, epoch: IdentityEpoch): Promise<{principal:string;projects:LocalProjectGrant} | undefined> {
  const token = /^Bearer (\S+)$/i.exec(header ?? '')?.[1];
  const result = await resolveBearer(secrets, token);
  // Delegated credentials retain their separate inference-only authority, never a workspace owner.
  if (!result.ok || result.resolved.delegation) return;
  const link = await resolveClientContextLink(secrets,result.resolved,epoch);
  return {principal:link?.ownerPrincipalId ?? localPrincipalId(epoch,result.resolved),projects:link?Object.freeze([link.projectId]):credentialProjectGrant(result.resolved)};
}
export async function isLocalPrincipalActive(principal: string, secrets: SecretStore, epoch: IdentityEpoch, now = new Date()): Promise<boolean> {
  const prefix = `${namespace(epoch)}_`;
  if (!principal.startsWith(prefix)) return false;
  const suffix = principal.slice(prefix.length);
  if (suffix !== 'admin' && !CLIENT_ID.test(suffix)) return false;
  const account = suffix === 'admin' ? 'local:api-token' : `local:client:${suffix}`;
  const token = await secrets.get(account);
  const result = await resolveBearer(secrets, token, now.getTime());
  return result.ok && !result.resolved.delegation && (suffix === 'admin' ? result.resolved.kind === 'admin' : result.resolved.kind === 'client' && result.resolved.clientId === suffix);
}
