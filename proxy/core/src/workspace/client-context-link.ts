import { createHash } from 'node:crypto';
import type { SecretStore } from '../secret-store.ts';
import { resolveBearer, type ResolvedClient } from '../client-keys.ts';
import { serialClientAuthority } from '../client-authority-lock.ts';
import { parseWorkspacePublicJwk } from './browser-session.ts';
import { PairingService, type ContextPairingApproval } from '../pairing.ts';
import type { IdentityEpoch } from './principal.ts';
import { isDataRecord } from '@uptokey/sync-contract/plain-data';
import { cancelStreamWithin } from '../stream-lifecycle.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const FIRST_PARTY = new Set(['pwa', 'tauri', 'tui']);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const contextEpoch = (epoch: IdentityEpoch) => digest(JSON.stringify(epoch ? [epoch.tenantId, epoch.deviceId] : ['local'])).slice(0, 24);
export const clientContextKey = (clientId: string) => `local:client-context:${clientId}`;
export class ContextLinkError extends Error {
  readonly code: string;
  readonly status: 400 | 401 | 403 | 404 | 409 | 429;
  constructor(code: string, status: 400 | 401 | 403 | 404 | 409 | 429 = 403) { super(code); this.code=code; this.status=status; }
}
const fail = (code = 'context_link_invalid', status: 400 | 401 | 403 | 404 | 409 | 429 = 403): never => { throw new ContextLinkError(code, status); };

export interface ClientContextLink extends ContextPairingApproval {
  schemaVersion: 1;
  recipientClientId: string;
  recipientKeyId: string;
  recipientPolicyRevision: number;
  recipientRegistrationRevision: number;
  epoch: string;
  revision: number;
  linkedAt: string;
  revokedAt: string | null;
}
export interface ContextLinkView {
  clientId: string;
  linked: boolean;
  revision: number;
  conversationId?: string;
  projectIds?: string[];
  reason?: 'context_link_invalid';
}

function parseLink(value: unknown, clientId: string): ClientContextLink {
  if (!isDataRecord(value)) return fail();
  const fields = ['schemaVersion','recipientClientId','recipientKeyId','recipientPolicyRevision','recipientRegistrationRevision','epoch','revision','linkedAt','revokedAt',
    'ownerPrincipalId','ownerClientId','ownerAdminDigest','ownerPolicyRevision','ownerRegistrationRevision','projectId','conversationId'];
  if (Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value,field)) ||
    value.schemaVersion !== 1 || value.recipientClientId !== clientId || !UUID.test(clientId) ||
    typeof value.recipientKeyId !== 'string' || !/^[0-9a-f]{64}$/.test(value.recipientKeyId) ||
    typeof value.epoch !== 'string' || !/^[0-9a-f]{24}$/.test(value.epoch) ||
    ![value.revision,value.recipientPolicyRevision,value.recipientRegistrationRevision].every(n => Number.isSafeInteger(n) && Number(n) >= 1) ||
    typeof value.linkedAt !== 'string' || !Number.isFinite(Date.parse(value.linkedAt)) ||
    !(value.revokedAt === null || typeof value.revokedAt === 'string' && Number.isFinite(Date.parse(value.revokedAt))) ||
    typeof value.projectId !== 'string' || !PROJECT.test(value.projectId) ||
    typeof value.conversationId !== 'string' || !CONVERSATION_ID.test(value.conversationId) ||
    typeof value.ownerPrincipalId !== 'string' || !new RegExp(`^${value.epoch}_(?:admin|[0-9a-f-]{36})$`).test(value.ownerPrincipalId)) return fail();
  if (value.ownerClientId === null) {
    if (value.ownerPrincipalId !== `${value.epoch}_admin` || typeof value.ownerAdminDigest !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value.ownerAdminDigest) || value.ownerPolicyRevision !== null || value.ownerRegistrationRevision !== null) return fail();
  } else if (typeof value.ownerClientId !== 'string' || !UUID.test(value.ownerClientId) || value.ownerClientId === clientId ||
    value.ownerPrincipalId !== `${value.epoch}_${value.ownerClientId}` || value.ownerAdminDigest !== null ||
    ![value.ownerPolicyRevision,value.ownerRegistrationRevision].every(n => Number.isSafeInteger(n) && Number(n) >= 1)) return fail();
  return value as unknown as ClientContextLink;
}

export async function readClientContextLink(secrets: SecretStore, clientId: string): Promise<ClientContextLink | undefined> {
  const raw = await secrets.get(clientContextKey(clientId));
  if (raw === undefined) return;
  try { return parseLink(JSON.parse(raw),clientId); } catch { return fail(); }
}

/** Raw credential scope: an approved context never grants permission to forward another owner's authority. */
export function credentialProjectGrant(client: ResolvedClient): '*' | readonly string[] {
  if (client.kind === 'admin') return '*';
  const registration = client.registration;
  if (!registration || !client.policy) return [];
  const policy = client.policy.projectIds;
  return registration.projects === '*' ? policy.length ? [...policy] : '*' : registration.projects.filter(id => !policy.length || policy.includes(id));
}
const grants = (client: ResolvedClient, projectId: string) => { const allowed = credentialProjectGrant(client); return allowed === '*' || allowed.includes(projectId); };
export function rawCredentialPrincipal(epoch: IdentityEpoch, client: ResolvedClient): string {
  return `${contextEpoch(epoch)}_${client.kind === 'admin' ? 'admin' : client.clientId}`;
}
async function keyId(secrets: SecretStore, clientId: string): Promise<string> {
  try {
    const raw = await secrets.get(`local:client:${clientId}:workspace-key`);
    if (!raw) return fail();
    return digest(JSON.stringify(parseWorkspacePublicJwk(JSON.parse(raw))));
  } catch { return fail(); }
}
function recipient(client: ResolvedClient): string {
  if (client.kind !== 'client' || client.delegation || !client.clientId || !client.policy ||
    !client.registration || !FIRST_PARTY.has(client.registration.audience) || client.policy.retentionMode === 'ephemeral') return fail('context_scope_denied');
  return client.clientId;
}
export async function authenticateContextCredential(header: string | undefined, secrets: SecretStore, now = Date.now()): Promise<ResolvedClient> {
  const token = /^Bearer (\S+)$/i.exec(header ?? '')?.[1];
  const result = await resolveBearer(secrets,token,now);
  if (!result.ok || result.resolved.delegation) return fail('unauthorized',401);
  return result.resolved;
}

async function ownerIsActive(secrets: SecretStore, approval: ContextPairingApproval, epoch: IdentityEpoch, now: number): Promise<boolean> {
  if (!approval.ownerPrincipalId.startsWith(`${contextEpoch(epoch)}_`)) return false;
  const token = await secrets.get(approval.ownerClientId === null ? 'local:api-token' : `local:client:${approval.ownerClientId}`);
  if (!token || approval.ownerClientId === null && digest(token) !== approval.ownerAdminDigest) return false;
  const result = await resolveBearer(secrets,token,now);
  if (!result.ok || result.resolved.delegation || rawCredentialPrincipal(epoch,result.resolved) !== approval.ownerPrincipalId) return false;
  if (approval.ownerClientId !== null && (result.resolved.kind !== 'client' ||
    result.resolved.policy?.revision !== approval.ownerPolicyRevision || result.resolved.registration?.policyRevision !== approval.ownerRegistrationRevision ||
    !FIRST_PARTY.has(result.resolved.registration?.audience ?? ''))) return false;
  return grants(result.resolved,approval.projectId) && result.resolved.policy?.retentionMode !== 'ephemeral';
}

/** Missing/revoked links keep the original owner. Damaged/expired links fail closed, never switch owners silently. */
export async function resolveClientContextLink(secrets: SecretStore, client: ResolvedClient, epoch: IdentityEpoch, now = Date.now()): Promise<ClientContextLink | undefined> {
  if (client.kind === 'admin' || !client.clientId) return;
  const link = await readClientContextLink(secrets,client.clientId);
  if (!link || link.revokedAt !== null) return;
  const id = recipient(client);
  if (link.epoch !== contextEpoch(epoch) || link.recipientClientId !== id || link.recipientKeyId !== await keyId(secrets,id) ||
    link.recipientPolicyRevision !== client.policy!.revision || link.recipientRegistrationRevision !== client.registration!.policyRevision ||
    !grants(client,link.projectId) || !await ownerIsActive(secrets,link,epoch,now)) return fail();
  // A revocation/replacement while owner validation awaited cannot reactivate an older binding.
  const current = await readClientContextLink(secrets,id);
  if (!current || current.revision !== link.revision || current.revokedAt !== null) return fail();
  return link;
}

/** A response header is not continuing authority to publish later owner-context bytes. */
export function guardContextResponse(response: Response, assertCurrent: () => Promise<void>): Response {
  if (!response.body) return response;
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        await assertCurrent();
        const chunk = await reader.read();
        // The upstream read can await a provider or journal event across revocation.
        await assertCurrent();
        if (chunk.done) {controller.close();reader.releaseLock();return;}
        controller.enqueue(chunk.value);
      } catch {
        await cancelStreamWithin(reader,250,'context_link_invalid').catch(()=>undefined);
        controller.error(new ContextLinkError('context_link_invalid'));
      }
    },
    async cancel(reason) {await cancelStreamWithin(reader,250,reason);},
  },{highWaterMark:0}); // Never prefetch owner bytes beyond a consumer's current read.
  return new Response(body,{status:response.status,headers:response.headers});
}

export class ClientContextLinkService {
  private readonly secrets: SecretStore;
  private readonly pairing: PairingService;
  private readonly epoch: () => IdentityEpoch;
  private readonly context: (principal: string, conversationId: string) => Promise<{id:string;projectId:string|null;revision:number}>;
  private readonly assertProject: (principal: string, projectId: string) => Promise<void>;
  private readonly now: () => number;
  constructor(secrets: SecretStore, pairing: PairingService, epoch: () => IdentityEpoch,
    context: (principal: string, conversationId: string) => Promise<{id:string;projectId:string|null;revision:number}>,
    assertProject: (principal: string, projectId: string) => Promise<void>, now: () => number = Date.now) {
    this.secrets=secrets;this.pairing=pairing;this.epoch=epoch;this.context=context;this.assertProject=assertProject;this.now=now;
  }

  async status(header: string | undefined): Promise<ContextLinkView> {
    const client = await authenticateContextCredential(header,this.secrets,this.now()), id = recipient(client);
    const stored = await readClientContextLink(this.secrets,id);
    try {
      const link = await resolveClientContextLink(this.secrets,client,this.epoch(),this.now());
      return link ? this.view(link) : {clientId:id,linked:false,revision:stored?.revision ?? 0};
    } catch(error) {
      if (!(error instanceof ContextLinkError)) throw error;
      return {clientId:id,linked:false,revision:stored?.revision ?? 0,reason:'context_link_invalid'};
    }
  }
  async challenge(header: string | undefined) {
    const client = await authenticateContextCredential(header,this.secrets,this.now()), id = recipient(client);
    const link = await readClientContextLink(this.secrets,id);
    return this.pairing.createContextLink({recipientClientId:id,recipientKeyId:await keyId(this.secrets,id),epoch:contextEpoch(this.epoch()),expectedBindingRevision:link?.revision ?? 0});
  }
  async approve(header: string | undefined, input: {id:string;userCode:string;conversationId:string;expectedRevision:number}) {
    const client = await authenticateContextCredential(header,this.secrets,this.now());
    if (client.kind === 'client' && (!client.registration || !FIRST_PARTY.has(client.registration.audience) || client.policy?.retentionMode === 'ephemeral')) return fail('context_scope_denied');
    const owner = rawCredentialPrincipal(this.epoch(),client);
    let selected;
    try { selected = await this.context(owner,input.conversationId); } catch { return fail('context_not_owned',404); }
    if (selected.revision !== input.expectedRevision) return fail('context_link_conflict',409);
    if (!selected.projectId) return fail('context_project_required',409);
    if (!grants(client,selected.projectId)) return fail('context_scope_denied');
    try { await this.assertProject(owner,selected.projectId); } catch { return fail('context_not_owned',404); }
    const token = /^Bearer (\S+)$/i.exec(header ?? '')?.[1]!;
    const approval: ContextPairingApproval = {ownerPrincipalId:owner,ownerClientId:client.kind === 'client' ? client.clientId! : null,
      ownerAdminDigest:client.kind === 'admin' ? digest(token) : null,ownerPolicyRevision:client.policy?.revision ?? null,
      ownerRegistrationRevision:client.registration?.policyRevision ?? null,projectId:selected.projectId,conversationId:selected.id};
    if (!await ownerIsActive(this.secrets,approval,this.epoch(),this.now())) return fail();
    if (!this.pairing.approveContextLink(input.id,input.userCode,approval)) return fail('context_link_pending_or_expired',409);
    return {approved:true as const};
  }
  async consume(header: string | undefined, id: string): Promise<ContextLinkView> {
    const client = await authenticateContextCredential(header,this.secrets,this.now()), recipientId = recipient(client);
    const result = await this.pairing.consumeContextLink(id,recipientId,pending => serialClientAuthority(this.secrets,`context:${recipientId}`,async () => {
      const old = await readClientContextLink(this.secrets,recipientId);
      if ((old?.revision ?? 0) !== pending.expectedBindingRevision) return fail('context_link_conflict',409);
      if (pending.epoch !== contextEpoch(this.epoch()) || pending.recipientKeyId !== await keyId(this.secrets,recipientId)) return fail();
      const active = await authenticateContextCredential(header,this.secrets,this.now());
      recipient(active);
      const approval = pending.approval!;
      if (!await ownerIsActive(this.secrets,approval,this.epoch(),this.now()) || !grants(active,approval.projectId)) return fail();
      try {
        const selected = await this.context(approval.ownerPrincipalId,approval.conversationId);
        if (selected.projectId !== approval.projectId) return fail();
        await this.assertProject(approval.ownerPrincipalId,approval.projectId);
      } catch { return fail('context_not_owned',404); }
      const link: ClientContextLink = {schemaVersion:1,...approval,recipientClientId:recipientId,recipientKeyId:pending.recipientKeyId,
        recipientPolicyRevision:active.policy!.revision,recipientRegistrationRevision:active.registration!.policyRevision,
        epoch:pending.epoch,revision:(old?.revision ?? 0)+1,linkedAt:new Date(this.now()).toISOString(),revokedAt:null};
      await this.secrets.set(clientContextKey(recipientId),JSON.stringify(link));
      const live = await authenticateContextCredential(header,this.secrets,this.now());
      await resolveClientContextLink(this.secrets,live,this.epoch(),this.now());
      return this.view(link);
    }));
    if (!result) return fail('context_link_pending_or_expired',409);
    return result;
  }
  async revoke(header: string | undefined, expectedRevision: number): Promise<ContextLinkView> {
    const client = await authenticateContextCredential(header,this.secrets,this.now()), id = recipient(client);
    return serialClientAuthority(this.secrets,`context:${id}`,async () => {
      const old = await readClientContextLink(this.secrets,id);
      if (!old || old.revision !== expectedRevision) return fail('context_link_conflict',409);
      const next = {...old,revision:old.revision+1,revokedAt:new Date(this.now()).toISOString()};
      await this.secrets.set(clientContextKey(id),JSON.stringify(next));
      return {clientId:id,linked:false,revision:next.revision};
    });
  }
  private view(link: ClientContextLink): ContextLinkView { return {clientId:link.recipientClientId,linked:true,revision:link.revision,conversationId:link.conversationId,projectIds:[link.projectId]}; }
}
