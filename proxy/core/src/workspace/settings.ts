// @ts-nocheck
/**
 * E2-23 — SettingsStore (preferências por escopo + jobs de export/purge).
 *
 * Dono: executor E2-23. Não altera ConversationStore/WorkspaceStore além de
 * chamar delete/export existentes. Preferências públicas; sem segredos.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Hono } from 'hono';
import { readBoundedJson } from '@uptokey/sync-contract/limits';
import {
  SETTINGS_SCHEMA_VERSION,
  parseSettingsPatch,
  parseExportRequest,
  parsePurgeRequest,
  clampPanelState,
  SETTINGS_LOCALES,
} from '@uptokey/sync-contract/settings';
import type { SecretStore } from '../secret-store.ts';
import { dataDir } from '../paths.ts';
import { WorkspaceError } from './runtime.ts';
import { WorkspacePrivacyError } from './store.ts';
import { sharedSinkAuthority, type SinkAccessPolicy } from './sink-authority.ts';

const SCHEMA_VERSION = 3;
const BODY_LIMIT_BYTES = 64 * 1024;
const EXPORT_TTL_MS = 60 * 60 * 1000;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings_docs(
  principal_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  revision INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, workspace_id, scope)
);
CREATE TABLE IF NOT EXISTS settings_jobs(
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  state TEXT NOT NULL,
  request_json TEXT NOT NULL,
  result_json TEXT,
  progress REAL NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT,
  expired_at TEXT,
  authorization_json TEXT,
  UNIQUE(principal_id, kind, idempotency_key)
);
CREATE TABLE IF NOT EXISTS settings_tombstones(
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  target_class TEXT NOT NULL,
  target_id TEXT NOT NULL,
  purged_at TEXT NOT NULL,
  authorization_json TEXT,
  UNIQUE(principal_id, target_class, target_id)
);
`;

function defaultDevice() {
  return {
    theme: 'dark',
    panelState: { leftCollapsed: false, rightCollapsed: false, leftWidth: 280, rightWidth: 320, dividerRatio: 0.5 },
    accessibility: { reducedMotion: false, contrast: null, fontScale: 1 },
  };
}

function defaultPrincipal() {
  return {
    locale: 'en',
    region: null,
    timezone: null,
    localeAuto: true,
    loggingIncludeContent: true,
    notificationSettings: { browserOptIn: false, channels: [], quietHours: null },
  };
}

function defaultWorkspace() {
  return {
    retentionDaysByClass: { conversation: 365, artifact: 365, local_receipts: 90, export_bundle: 7 },
    exportAllowed: true,
    effectivePolicyRef: null,
  };
}

function mergeDeep(base, patch) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = mergeDeep(base[key], value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

// Server-derived resource provenance. Never accepted from an HTTP request body,
// and kept outside exported content so expiry/deletion cannot erase authorization.
export type PrivacyJobAuthority = { version: 1; projectIds: Array<string | null> };
export function parsePrivacyAuthority(value: unknown): PrivacyJobAuthority | undefined {
  if (!value || typeof value !== 'object' || value.version !== 1 || !Array.isArray(value.projectIds) ||
      !value.projectIds.every(id => id === null || typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(id))) return undefined;
  return {version:1,projectIds:[...new Set(value.projectIds)]};
}

export function exportPrivacyAuthority(request, result): PrivacyJobAuthority | undefined {
  if (request.kind === 'preferences') return {version:1,projectIds:[]};
  const items = result?.artifact?.items;
  if (!Array.isArray(items)) return undefined;
  if (request.kind === 'receipts') return parsePrivacyAuthority({version:1,projectIds:items.map(item => item?.projectId)});
  if (request.kind === 'conversations' && items.length === 1 && items[0]?.conversation?.id === request.conversationId) {
    return parsePrivacyAuthority({version:1,projectIds:[items[0].conversation.projectId]});
  }
  return undefined;
}

export class SettingsStore {
  #db;
  #root;
  #jobs:Promise<unknown>=Promise.resolve();
  #sinkPolicy: SinkAccessPolicy;
  constructor(root, options: { sinkPolicy?: SinkAccessPolicy } = {}) {
    this.#root = root;
    this.#sinkPolicy = options.sinkPolicy ?? sharedSinkAuthority();
    mkdirSync(root, { recursive: true });
    this.#db = new DatabaseSync(join(root, 'settings.db'));
    this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    try {
      this.#db.exec(SCHEMA_SQL);
      // Additive migration: retain all jobs, request bindings and existing preferences.
      // The durable marker prevents a clock rollback from reviving expired results.
      this.#db.exec('BEGIN IMMEDIATE');
      try {
        const columns = this.#db.prepare('PRAGMA table_info(settings_jobs)').all();
        if (!columns.some(column => column.name === 'expired_at')) {
          this.#db.exec('ALTER TABLE settings_jobs ADD COLUMN expired_at TEXT');
        }
        if (!columns.some(column => column.name === 'authorization_json')) {
          this.#db.exec('ALTER TABLE settings_jobs ADD COLUMN authorization_json TEXT');
        }
        if (!this.#db.prepare('PRAGMA table_info(settings_tombstones)').all().some(column => column.name === 'authorization_json')) {
          this.#db.exec('ALTER TABLE settings_tombstones ADD COLUMN authorization_json TEXT');
        }
        this.#db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(SCHEMA_VERSION, new Date().toISOString());
        this.#db.exec('COMMIT');
      } catch (error) {
        this.#db.exec('ROLLBACK');
        throw error;
      }
      this.#expireExports();
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  close() {
    try { this.#expireExports(); } finally { this.#db.close(); }
  }

  now() {
    return new Date();
  }

  #assertSink(principalId) {
    try { this.#sinkPolicy.assertSinkAllowed(principalId, 'sqlite:settings'); }
    catch { throw new WorkspaceError('ephemeral_mode_persistence_blocked', 403); }
  }

  #exportExpired(row, at) {
    return row.kind === 'export' && (row.expired_at != null || !row.expires_at ||
      !Number.isFinite(Date.parse(row.expires_at)) || Date.parse(row.expires_at) <= at.getTime());
  }

  #expireExports(at = this.now()) {
    // Logical deletion from the active database, not forensic erasure of SQLite/WAL.
    // No timer: startup and ordinary store access are the cleanup boundaries.
    // This may run inside an existing preference transaction; never start a nested one.
    const rows = this.#db.prepare(`SELECT id, kind, state, expires_at, expired_at FROM settings_jobs
      WHERE kind='export' AND (result_json IS NOT NULL OR (expired_at IS NULL AND state!='cancelled'))`).all();
    const expire = this.#db.prepare(`UPDATE settings_jobs SET result_json=NULL,
      state=CASE WHEN state='cancelled' THEN state ELSE 'failed' END,
      expired_at=COALESCE(expired_at, ?), updated_at=? WHERE id=? AND expires_at IS ?`);
    for (const row of rows) {
      if (this.#exportExpired(row, at)) {
        // Preserve trustworthy legacy project metadata before removing its payload.
        const full = this.#db.prepare('SELECT * FROM settings_jobs WHERE id=?').get(row.id);
        const authority = this.#authorityFromRow(full);
        if (authority && full.authorization_json == null) this.#db.prepare('UPDATE settings_jobs SET authorization_json=? WHERE id=?').run(JSON.stringify(authority),row.id);
        expire.run(at.toISOString(), at.toISOString(), row.id, row.expires_at);
      }
    }
  }

  #txn(fn) {
    this.#expireExports();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw error;
    }
  }

  async #txnAsync<T>(fn:()=>Promise<T>):Promise<T> {
    // External owners may await I/O. Never hold a SQLite transaction across that await:
    // independent preference patches use the same connection and need their own transaction.
    const result=this.#jobs.then(() => { this.#expireExports(); return fn(); });
    this.#jobs=result.catch(()=>undefined);
    return result;
  }

  #defaults(scope) {
    if (scope === 'device') return defaultDevice();
    if (scope === 'principal') return defaultPrincipal();
    return defaultWorkspace();
  }

  getDoc(principalId, workspaceId, scope) {
    this.#expireExports();
    const row = this.#db.prepare(
      'SELECT revision, payload_json, updated_at FROM settings_docs WHERE principal_id=? AND workspace_id=? AND scope=?',
    ).get(principalId, workspaceId, scope);
    if (!row) {
      return {
        schemaVersion: SETTINGS_SCHEMA_VERSION,
        scope,
        revision: 0,
        updatedAt: null,
        preferences: this.#defaults(scope),
      };
    }
    return {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      scope,
      revision: row.revision,
      updatedAt: row.updated_at,
      preferences: JSON.parse(row.payload_json),
    };
  }

  patchDoc(principalId, workspaceId, patch) {
    return this.#txn(() => {
      this.#assertSink(principalId);
      const current = this.getDoc(principalId, workspaceId, patch.scope);
      if (current.revision !== patch.expectedRevision) {
        throw new WorkspaceError('settings_conflict', 409);
      }
      const slice = patch.scope === 'device' ? patch.device : patch.scope === 'principal' ? patch.principal : patch.workspace;
      let next = mergeDeep(current.preferences, slice || {});
      if (patch.scope === 'device' && next.panelState) {
        next = { ...next, panelState: clampPanelState(next.panelState) };
      }
      const revision = current.revision + 1;
      const updatedAt = this.now().toISOString();
      this.#db.prepare(`
        INSERT INTO settings_docs(principal_id, workspace_id, scope, revision, payload_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(principal_id, workspace_id, scope) DO UPDATE SET
          revision=excluded.revision, payload_json=excluded.payload_json, updated_at=excluded.updated_at
      `).run(principalId, workspaceId, patch.scope, revision, JSON.stringify(next), updatedAt);
      return {
        schemaVersion: SETTINGS_SCHEMA_VERSION,
        scope: patch.scope,
        revision,
        updatedAt,
        preferences: next,
      };
    });
  }

  getBundle(principalId, workspaceId) {
    return {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      device: this.getDoc(principalId, workspaceId, 'device'),
      principal: this.getDoc(principalId, workspaceId, 'principal'),
      workspace: this.getDoc(principalId, workspaceId, 'workspace'),
    };
  }

  #jobFromRow(row) {
    const at = this.now();
    const expired = this.#exportExpired(row, at);
    if (expired && (row.result_json != null || (row.expired_at == null && row.state !== 'cancelled'))) {
      this.#expireExports(at);
      row = this.#db.prepare('SELECT * FROM settings_jobs WHERE id=?').get(row.id);
    }
    return {
      id: row.id,
      kind: row.kind,
      state: expired && row.state !== 'cancelled' ? 'failed' : row.state,
      progress: row.progress,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
      result: !expired && row.result_json ? JSON.parse(row.result_json) : null,
      ...(expired && row.state !== 'cancelled' ? {error:'export_expired'} : {}),
      request: JSON.parse(row.request_json),
    };
  }

  #replayJob(row, workspaceId, request) {
    const original = JSON.parse(row.request_json);
    // Compare the semantic request, not object key order. Defaults match the HTTP contract.
    const same = row.workspace_id === workspaceId && (row.kind === 'export'
      ? original.kind === request.kind && (original.conversationId ?? null) === (request.conversationId ?? null)
        && original.includeContent === request.includeContent
      : original.targetClass === request.targetClass && original.targetId === request.targetId
        && (original.scope ?? 'principal') === (request.scope ?? 'principal'));
    if (!same) throw new WorkspaceError('settings_idempotency_conflict',409);
    return this.#jobFromRow(row);
  }

  #authorityFromRow(row): PrivacyJobAuthority | undefined {
    if (row.authorization_json != null) {
      const value = parsePrivacyAuthority(JSON.parse(row.authorization_json));
      if (!value) throw new WorkspaceError('settings_provenance_invalid',500);
      return value;
    }
    return row.kind === 'export' ? exportPrivacyAuthority(JSON.parse(row.request_json),row.result_json ? JSON.parse(row.result_json) : null) : undefined;
  }

  getJobAuthority(principalId, jobId): PrivacyJobAuthority | undefined {
    const row = this.#db.prepare('SELECT * FROM settings_jobs WHERE id=? AND principal_id=?').get(jobId,principalId);
    if (!row) throw new WorkspaceError('settings_job_not_found',404);
    return this.#authorityFromRow(row);
  }

  async createExportJob(principalId, workspaceId, request, { conversationExporter, receiptsExporter, authorize } = {}) {
    if (!this.getDoc(principalId, workspaceId, 'workspace').preferences.exportAllowed) throw new WorkspaceError('export_forbidden',403);
    this.#assertSink(principalId);
    return this.#txnAsync(async () => {
      const existing = this.#db.prepare(
        'SELECT * FROM settings_jobs WHERE principal_id=? AND kind=? AND idempotency_key=?',
      ).get(principalId, 'export', request.idempotencyKey);
      if (existing) {
        const job = this.#replayJob(existing,workspaceId,request);
        await authorize?.(job,this.#authorityFromRow(existing));
        return this.getJob(principalId,job.id);
      }
      await authorize?.();
      if (!this.getDoc(principalId,workspaceId,'workspace').preferences.exportAllowed) throw new WorkspaceError('export_forbidden',403);

      const principalPrefs = this.getDoc(principalId, workspaceId, 'principal').preferences;
      const includeContent = request.includeContent ?? principalPrefs.loggingIncludeContent !== false;
      const id = randomUUID();
      const now = this.now().toISOString();
      const expiresAt = new Date(this.now().getTime() + EXPORT_TTL_MS).toISOString();
      let artifact = {
        omitSecrets: true,
        includeContent,
        items: [],
        note: includeContent ? 'content_included_per_preference' : 'content_omitted_by_logging_preference',
      };
      if (request.kind === 'preferences') {
        artifact.items = [this.getBundle(principalId, workspaceId)];
      } else if (request.kind === 'conversations' && typeof conversationExporter === 'function' && request.conversationId) {
        const exported = await Promise.resolve(conversationExporter(principalId, request.conversationId));
        if (exported && includeContent === false && Array.isArray(exported.messages)) {
          artifact.items = [{
            ...exported,
            messages: exported.messages.map((m) => ({
              id: m.id,
              role: m.role,
              createdAt: m.createdAt,
              parts: (m.parts || []).map((p) => ({ type: p.type, redacted: true })),
            })),
          }];
        } else if (exported) {
          artifact.items = [exported];
        }
        if(!exported)throw new WorkspaceError('conversation_not_found',404);
      } else if (request.kind === 'receipts') {
        if(typeof receiptsExporter!=='function')throw new WorkspaceError('receipts_export_unavailable',503);
        artifact.items=await receiptsExporter(principalId,includeContent);
      } else if(request.kind==='conversations') {
        throw new WorkspaceError('conversation_export_unavailable',503);
      }
      const provenance = exportPrivacyAuthority(request,{artifact});
      const authorization = await authorize?.({kind:'export',request,result:{artifact}},provenance) ?? provenance;
      if (!this.getDoc(principalId,workspaceId,'workspace').preferences.exportAllowed) throw new WorkspaceError('export_forbidden',403);
      // An external owner may have crossed the TTL while awaited. Never insert
      // an already expired payload, even briefly; retain only the idempotent job.
      const completedAt = this.now();
      const expiredAt = Date.parse(expiresAt) <= completedAt.getTime() ? completedAt.toISOString() : null;
      const sealed = expiredAt === null ? JSON.stringify(artifact) : null;
      // Never include vault/env markers.
      if (sealed !== null && /BEGIN [A-Z ]*PRIVATE KEY|api[_-]?key|sk-[a-zA-Z0-9]/i.test(sealed)) {
        throw new WorkspaceError('export_invalid', 400);
      }
      const result = expiredAt === null ? { artifactId: id, expiresAt, byteLength: Buffer.byteLength(sealed), digest: createHash('sha256').update(sealed).digest('hex'), artifact } : null;
      this.#assertSink(principalId);
      this.#db.prepare(`
        INSERT INTO settings_jobs(id, principal_id, workspace_id, kind, idempotency_key, state, request_json, result_json, progress, created_at, updated_at, expires_at, expired_at, authorization_json)
        VALUES (?, ?, ?, 'export', ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
      `).run(id, principalId, workspaceId, request.idempotencyKey, expiredAt === null ? 'completed' : 'failed', JSON.stringify(request), result === null ? null : JSON.stringify(result), now, expiredAt ?? now, expiresAt, expiredAt, authorization ? JSON.stringify(authorization) : null);
      return this.#jobFromRow(this.#db.prepare('SELECT * FROM settings_jobs WHERE id=?').get(id));
    });
  }

  async createPurgeJob(principalId, workspaceId, request, { conversationDeleter, artifactDeleter, receiptDeleter, authorize } = {}) {
    this.#assertSink(principalId);
    return this.#txnAsync(async () => {
      const existing = this.#db.prepare(
        'SELECT * FROM settings_jobs WHERE principal_id=? AND kind=? AND idempotency_key=?',
      ).get(principalId, 'purge', request.idempotencyKey);
      if (existing) {
        const job = this.#replayJob(existing,workspaceId,request);
        await authorize?.(job,this.#authorityFromRow(existing));
        return job;
      }

      const tombstone = this.#db.prepare(
        'SELECT id, authorization_json FROM settings_tombstones WHERE principal_id=? AND target_class=? AND target_id=?',
      ).get(principalId, request.targetClass, request.targetId);
      const priorAuthority = tombstone?.authorization_json ? parsePrivacyAuthority(JSON.parse(tombstone.authorization_json)) : undefined;
      if (tombstone?.authorization_json && !priorAuthority) throw new WorkspaceError('settings_provenance_invalid',500);
      const authorization = await authorize?.(undefined,priorAuthority) ?? priorAuthority;
      const revalidate = async () => { await authorize?.(undefined,authorization); };
      const id = randomUUID();
      const now = this.now().toISOString();
      let removed = false;
      if (!tombstone) {
        if (request.targetClass === 'conversation' && typeof conversationDeleter === 'function') {
          removed = Boolean(await Promise.resolve(conversationDeleter(principalId, request.targetId,revalidate)));
        } else if(request.targetClass==='export_bundle') {
          const existingExport=this.#db.prepare("SELECT id FROM settings_jobs WHERE id=? AND principal_id=? AND kind='export'").get(request.targetId,principalId);
          if(!existingExport)throw new WorkspaceError('settings_job_not_found',404);
          await revalidate();
          this.#db.prepare("UPDATE settings_jobs SET result_json=NULL,state='cancelled',updated_at=? WHERE id=? AND principal_id=?").run(now,request.targetId,principalId);
          removed=true;
        } else if(request.targetClass==='artifact'&&typeof artifactDeleter==='function') {
          removed=Boolean(await artifactDeleter(principalId,request.targetId,revalidate));
        } else if(request.targetClass==='local_receipts'&&typeof receiptDeleter==='function') {
          removed=Boolean(await receiptDeleter(principalId,request.targetId,revalidate));
        } else {
          throw new WorkspaceError('purge_executor_unavailable',503);
        }
        if(!removed)throw new WorkspaceError('purge_not_applied',409);
      }
      const result = {
        tombstone: true,
        removed: removed || Boolean(tombstone),
        alreadyPurged: Boolean(tombstone),
        targetClass: request.targetClass,
        targetId: request.targetId,
      };
      this.#assertSink(principalId);
      return this.#txn(()=>{
      if(!tombstone)this.#db.prepare(`INSERT INTO settings_tombstones(id, principal_id, workspace_id, target_class, target_id, purged_at, authorization_json) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(),principalId,workspaceId,request.targetClass,request.targetId,now,authorization ? JSON.stringify(authorization) : null);
      this.#db.prepare(`
        INSERT INTO settings_jobs(id, principal_id, workspace_id, kind, idempotency_key, state, request_json, result_json, progress, created_at, updated_at, expires_at, authorization_json)
        VALUES (?, ?, ?, 'purge', ?, 'completed', ?, ?, 1, ?, ?, NULL, ?)
      `).run(id, principalId, workspaceId, request.idempotencyKey, JSON.stringify(request), JSON.stringify(result), now, now,authorization ? JSON.stringify(authorization) : null);
      return this.#jobFromRow(this.#db.prepare('SELECT * FROM settings_jobs WHERE id=?').get(id));
      });
    });
  }

  getJob(principalId, jobId) {
    this.#expireExports();
    const row = this.#db.prepare('SELECT * FROM settings_jobs WHERE id=? AND principal_id=?').get(jobId, principalId);
    if (!row) throw new WorkspaceError('settings_job_not_found', 404);
    return this.#jobFromRow(row);
  }

  hasTombstone(principalId, targetClass, targetId) {
    this.#expireExports();
    return Boolean(this.#db.prepare(
      'SELECT 1 FROM settings_tombstones WHERE principal_id=? AND target_class=? AND target_id=?',
    ).get(principalId, targetClass, targetId));
  }
}

export function resolveSettingsRoot() {
  return process.env.UPTOKEY_SETTINGS_DIR || join(dataDir(), 'settings');
}

const SETTINGS_UUID = '[0-9a-fA-F-]{36}';
const SETTINGS_PATH = new RegExp(`^/v1/workspace/settings(?:/(bundle|resources|export|purge|jobs/(${SETTINGS_UUID})|(device|principal|workspace)))?$`);

export function settingsMethod(path, method) {
  const match = SETTINGS_PATH.exec(path);
  if (!match) return undefined;
  if (method === 'GET' || method === 'POST') return method;
  return undefined;
}

export function settingsQueryAllowed(url) {
  return SETTINGS_PATH.test(url.pathname) && [...url.searchParams.keys()].every((k) => ['viewportWidth'].includes(k));
}

export function mountSettingsRoutes(app, deps) {
  const store = deps.store ?? new SettingsStore(deps.root ?? resolveSettingsRoot(), { sinkPolicy: deps.sinkPolicy });
  const principalOf = deps.principal;
  const ready = deps.ready;

  const withOwner = async (c) => {
    if (typeof ready==='function') { if(!(await ready()))throw new WorkspaceError('workspace_not_ready',503); }
    else if(ready)await ready;
    const owner = await principalOf(c.req.header('authorization'));
    if(typeof owner==='string'&&owner)return {ownerId:owner,workspaceId:owner};
    if (!owner?.id) throw new WorkspaceError('settings_unauthorized', 403);
    return { ownerId: owner.id, workspaceId: owner.workspaceId || owner.id };
  };

  app.get('/v1/workspace/settings/bundle', async (c) => {
    try {
      const { ownerId, workspaceId } = await withOwner(c);
      return c.json(store.getBundle(ownerId, workspaceId));
    } catch (error) {
      if (error instanceof WorkspaceError) return c.json({ error: { type: error.code } }, error.status);
      throw error;
    }
  });

  app.get('/v1/workspace/settings/resources',async c=>{
    try{
      const {ownerId}=await withOwner(c);
      if(typeof deps.resourceLister!=='function')throw new WorkspaceError('privacy_resources_unavailable',503);
      return c.json({resources:await deps.resourceLister(ownerId,c.req.header('authorization'))});
    }catch(error){if(error instanceof WorkspaceError||error instanceof WorkspacePrivacyError)return c.json({error:{type:error.code}},error.status);throw error;}
  });

  for (const scope of ['device', 'principal', 'workspace']) {
    app.get(`/v1/workspace/settings/${scope}`, async (c) => {
      try {
        const { ownerId, workspaceId } = await withOwner(c);
        const doc = store.getDoc(ownerId, workspaceId, scope);
        const viewportWidth = Number(c.req.query('viewportWidth') || 1280);
        if (scope === 'device' && doc.preferences?.panelState) {
          doc.preferences = {
            ...doc.preferences,
            panelState: clampPanelState(doc.preferences.panelState, viewportWidth),
          };
        }
        return c.json(doc);
      } catch (error) {
        if (error instanceof WorkspaceError) return c.json({ error: { type: error.code } }, error.status);
        throw error;
      }
    });

    app.post(`/v1/workspace/settings/${scope}`, async (c) => {
      try {
        const { ownerId, workspaceId } = await withOwner(c);
        const body = await readBoundedJson(c.req.raw, BODY_LIMIT_BYTES);
        if(!body.ok)throw new WorkspaceError(body.reason==='too_large'?'settings_request_too_large':'settings_invalid',body.reason==='too_large'?413:400);
        const patch = parseSettingsPatch({ ...body.value, scope });
        return c.json(store.patchDoc(ownerId, workspaceId, patch));
      } catch (error) {
        if (error?.code === 'settings_invalid' || error?.message === 'settings_invalid') {
          return c.json({ error: { type: 'settings_invalid' } }, 400);
        }
        if (error instanceof WorkspaceError) return c.json({ error: { type: error.code } }, error.status);
        throw error;
      }
    });
  }

  app.post('/v1/workspace/settings/export', async (c) => {
    try {
      const { ownerId, workspaceId } = await withOwner(c);
      const body = await readBoundedJson(c.req.raw, BODY_LIMIT_BYTES);
      if(!body.ok)throw new WorkspaceError(body.reason==='too_large'?'settings_request_too_large':'export_invalid',body.reason==='too_large'?413:400);
      const request = parseExportRequest(body.value);
      const job = await store.createExportJob(ownerId, workspaceId, request, {
        authorize: (job,authority) => deps.authorizePrivacy?.(c.req.header('authorization'),ownerId,'export',request,job,authority),
        conversationExporter: deps.conversationExporter,
        receiptsExporter: typeof deps.receiptsExporter==='function'?(principal,includeContent)=>deps.receiptsExporter(principal,includeContent,c.req.header('authorization')):undefined,
      });
      await deps.authorizePrivacy?.(c.req.header('authorization'),ownerId,job.kind,job.request,job);
      // Authorization can await the vault while TTL/purge invalidates payloads.
      // Re-read immediately before delivery; never emit the earlier object.
      return c.json(store.getJob(ownerId,job.id));
    } catch (error) {
      if (error?.code === 'export_invalid' || error?.message === 'export_invalid') {
        return c.json({ error: { type: 'export_invalid' } }, 400);
      }
      if (error instanceof WorkspaceError) return c.json({ error: { type: error.code } }, error.status);
      throw error;
    }
  });

  app.post('/v1/workspace/settings/purge', async (c) => {
    try {
      const { ownerId, workspaceId } = await withOwner(c);
      const body = await readBoundedJson(c.req.raw, BODY_LIMIT_BYTES);
      if(!body.ok)throw new WorkspaceError(body.reason==='too_large'?'settings_request_too_large':'purge_invalid',body.reason==='too_large'?413:400);
      const request = parsePurgeRequest(body.value);
      const job = await store.createPurgeJob(ownerId, workspaceId, request, {
        authorize: (job,authority) => deps.authorizePrivacy?.(c.req.header('authorization'),ownerId,'purge',request,job,authority),
        conversationDeleter: deps.conversationDeleter,
        artifactDeleter: deps.artifactDeleter,
        receiptDeleter: deps.receiptDeleter,
      });
      await deps.authorizePrivacy?.(c.req.header('authorization'),ownerId,job.kind,job.request,job);
      return c.json(job);
    } catch (error) {
      if(error instanceof WorkspacePrivacyError)return c.json({error:{type:error.code}},error.status);
      if (error?.code === 'purge_invalid' || error?.message === 'purge_invalid') {
        return c.json({ error: { type: 'purge_invalid' } }, 400);
      }
      if (error instanceof WorkspaceError) return c.json({ error: { type: error.code } }, error.status);
      throw error;
    }
  });

  app.get(`/v1/workspace/settings/jobs/:jobId`, async (c) => {
    try {
      const { ownerId } = await withOwner(c);
      const job=store.getJob(ownerId,c.req.param('jobId'));
      await deps.authorizePrivacy?.(c.req.header('authorization'),ownerId,job.kind,job.request,job);
      return c.json(store.getJob(ownerId,job.id));
    } catch (error) {
      if (error instanceof WorkspaceError) return c.json({ error: { type: error.code } }, error.status);
      throw error;
    }
  });

  return { store, close: () => store.close() };
}

export { SETTINGS_LOCALES };
