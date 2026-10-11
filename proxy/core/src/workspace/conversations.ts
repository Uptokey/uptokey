/**
 * E2-01 — repositório canônico de conversas (SQLite local, payloads selados).
 *
 * Dono: executor E2-01. O WorkspaceStore/journal continuam donos de runs,
 * aprovações e artefatos; este módulo é dono de conversas/mensagens/eventos
 * e da outbox de intenções. Runs W5 são referenciados por RunLink, nunca
 * duplicados aqui. Nenhum texto de mensagem aparece em claro no arquivo.
 *
 * Persistência: `node:sqlite` (motor SQLite embutido, sem dependência nova)
 * em `<root>/conversations.db`, WAL, chave AES-256-GCM no cofre do SO
 * (`local:conversation-store-key`). Delta registrado no handoff E2-01: a
 * arquitetura propunha better-sqlite3 instalado; o contrato SQL, os dados e
 * o template são idênticos, sem risco de compilação nativa.
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { Hono } from 'hono';
import { isProjectGranted, type LocalProjectGrant } from './principal.ts';
import { readBoundedJson } from '@uptokey/sync-contract/limits';
import { canonicalJson } from '@uptokey/sync-contract/canonical';
import {
  CONVERSATION_SCHEMA_VERSION,
  CONVERSATION_MAX_MESSAGES_PER_CONVERSATION,
  parseConversation,
  parseMessage,
  parseMessagePart,
  parseSendMessage,
  parseRunLink,
  parseConversationEvent,
  parseListQuery,
  parseImportSessions,
  parseConversationPolicyPatch,
  canonicalImportPayload,
  type ConversationEvent,
  type RunLink,
} from '@uptokey/sync-contract/conversation';
import type { SecretStore } from '../secret-store.ts';
import type { RunStatus, StepState, ExecutionReceipt } from '@uptokey/sync-contract/workflow';
import { dataDir } from '../paths.ts';
import { WorkspaceError } from './runtime.ts';

const CONVERSATION_KEY_ACCOUNT = 'local:conversation-store-key';
// v2: policy columns. v3: additive admission identities; existing run links remain historical.
const SCHEMA_VERSION = 3;
const BODY_LIMIT_BYTES = 256 * 1024;
const IMPORT_BODY_LIMIT_BYTES = 1024 * 1024;
// Closing the browser is best-effort; expired in-memory sessions are also
// collected by the server, without persisting their contents for recovery.
export const TEMPORARY_CONVERSATION_IDLE_MS = 30 * 60 * 1000;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS conversations(
  id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  project_id TEXT, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL, archived_at TEXT, active_branch_id TEXT NOT NULL,
  instruction_profile_ref TEXT, instruction_profile_rev INTEGER,
  origin TEXT, origin_digest TEXT,
  storage_policy TEXT NOT NULL DEFAULT 'local',
  processing_policy TEXT NOT NULL DEFAULT 'local_only',
  cloud_sync_opt_in INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_conversations_owner ON conversations(principal_id, updated_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS messages(
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, parent_id TEXT, branch_id TEXT NOT NULL,
  role TEXT NOT NULL, client_message_id TEXT NOT NULL, created_at TEXT NOT NULL, revision INTEGER NOT NULL,
  sealed_nonce TEXT NOT NULL, sealed_ciphertext TEXT NOT NULL, sealed_tag TEXT NOT NULL,
  UNIQUE(conversation_id, client_message_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at ASC, id ASC);
CREATE TABLE IF NOT EXISTS message_parts(
  id TEXT PRIMARY KEY, message_id TEXT NOT NULL, type TEXT NOT NULL, artifact_ref TEXT,
  call_id TEXT, name TEXT, sealed_nonce TEXT NOT NULL, sealed_ciphertext TEXT NOT NULL, sealed_tag TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_parts_message ON message_parts(message_id);
CREATE TABLE IF NOT EXISTS run_links(
  request_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, message_id TEXT NOT NULL,
  project_id TEXT NOT NULL, run_id TEXT NOT NULL, provider_id TEXT, account_ref TEXT,
  model_id TEXT NOT NULL, state TEXT NOT NULL, last_sequence INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_links_conv ON run_links(conversation_id);
CREATE TABLE IF NOT EXISTS conversation_events(
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, run_id TEXT, sequence INTEGER NOT NULL,
  type TEXT NOT NULL, sealed_nonce TEXT NOT NULL, sealed_ciphertext TEXT NOT NULL, sealed_tag TEXT NOT NULL,
  created_at TEXT NOT NULL, UNIQUE(conversation_id, sequence)
);
CREATE TABLE IF NOT EXISTS conversation_outbox(
  request_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, message_id TEXT NOT NULL,
  state TEXT NOT NULL, attempts INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversation_run_admissions(
  request_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL, project_id TEXT NOT NULL, run_request_id TEXT NOT NULL,
  plan_id TEXT NOT NULL, plan_digest TEXT NOT NULL,
  UNIQUE(principal_id, project_id, run_request_id)
);
CREATE TABLE IF NOT EXISTS conversation_imports(
  origin_digest TEXT PRIMARY KEY, conversation_ids TEXT NOT NULL, created_at TEXT NOT NULL
);
`;


export type StoragePolicy = 'local' | 'temporary' | 'cloud';
export type ProcessingPolicy = 'local_only' | 'external_allowed';

export interface ConversationRunAdmission {
  principalId: string; conversationId: string; messageId: string; requestId: string;
  projectId: string; runRequestId: string; planId: string; planDigest: string;
}

export interface ConversationPaths {
  create: string;
  item: string;
  update: string;
  remove: string;
  export: string;
  messages: string;
  runsLink: string;
  runsState: string;
  events: string;
  outbox: string;
  import: string;
}

function workspaceIdFor(principalId: string): string {
  const hex = createHash('sha256').update(`uptokey-conversation-workspace-v1|${principalId}`).digest('hex');
  // UUID v4-shaped determinístico por principal (fixa versão/variante).
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function toWorkspaceError(error: unknown): WorkspaceError {
  if (error instanceof WorkspaceError) return error;
  if (error instanceof Error) {
    if (error.message === 'payload_too_large') return new WorkspaceError('payload_too_large', 400);
    if (error.message === 'import_invalid') return new WorkspaceError('import_invalid', 400);
    if (error.message === 'invalid_part') return new WorkspaceError('invalid_part', 400);
    if (error.message === 'conversation_invalid') return new WorkspaceError('conversation_invalid', 400);
    if (error.message === 'cloud_sync_not_opted_in') return new WorkspaceError('cloud_sync_not_opted_in', 403);
  }
  throw error;
}

export class ConversationStore {
  private db: DatabaseSync | null = null;
  private runAuthority: RunAuthority | undefined;
  private runRequestAuthority: RunRequestAuthority | undefined;
  private masterKey: Buffer | null = null;
  private inTransaction = false;
  private masterKeyPromise: Promise<Buffer> | null = null;
  private temporarySweep: ReturnType<typeof setInterval> | null = null;
  private readonly temporaryConversations = new Map<string, {
    principalId: string;
    lastAccessAt: number;
    conversation: ReturnType<typeof parseConversation>;
    storagePolicy: 'temporary';
    processingPolicy: ProcessingPolicy;
    messages: Map<string, {
      message: ReturnType<typeof parseMessage>;
      parts: ReturnType<typeof parseMessagePart>[];
      bodyDigest: string;
      outboxRequestId: string | null;
    }>;
    events: ConversationEvent[];
    runLinks: Map<string, RunLink>;
    admissions: Map<string, ConversationRunAdmission>;
    outbox: Array<{
      requestId: string;
      conversationId: string;
      messageId: string;
      state: string;
      attempts: number;
      createdAt: string;
      updatedAt: string;
    }>;
  }>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly secrets: SecretStore;
  private readonly root: string;
  private readonly now: () => Date;
  private readonly onTemporaryConversationEnded?: (principalId: string, conversationId: string) => void;

  constructor(
    secrets: SecretStore,
    root: string,
    now: () => Date = () => new Date(),
    options: { onTemporaryConversationEnded?: (principalId: string, conversationId: string) => void } = {},
  ) {
    this.secrets = secrets;
    this.root = root;
    this.now = now;
    this.onTemporaryConversationEnded = options.onTemporaryConversationEnded;
  }

  /** Abre o banco (idempotente) e aplica o schema. */
  open(): void {
    if (this.db) return;
    mkdirSync(this.root, { recursive: true });
    const db = new DatabaseSync(join(this.root, 'conversations.db'));
    db.exec('PRAGMA journal_mode=WAL;');
    db.exec('PRAGMA busy_timeout=5000;');
    db.exec(SCHEMA_SQL);
    const applied = new Set(
      (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((row) => row.version),
    );
    if (!applied.has(SCHEMA_VERSION)) {
      // Migração incremental (não destrutiva): políticas e tabela de admissão acima.
      // Bancos novos já trazem as colunas via SCHEMA_SQL; o ALTER só roda em
      // bancos v1 existentes. Os defaults cobrem linhas antigas.
      const columns = new Set(
        (db.prepare('PRAGMA table_info(conversations)').all() as { name: string }[]).map((column) => column.name),
      );
      db.exec('BEGIN IMMEDIATE');
      try {
        if (!columns.has('storage_policy')) {
          db.exec(`ALTER TABLE conversations ADD COLUMN storage_policy TEXT NOT NULL DEFAULT 'local'`);
        }
        if (!columns.has('processing_policy')) {
          db.exec(`ALTER TABLE conversations ADD COLUMN processing_policy TEXT NOT NULL DEFAULT 'local_only'`);
        }
        if (!columns.has('cloud_sync_opt_in')) {
          db.exec(`ALTER TABLE conversations ADD COLUMN cloud_sync_opt_in INTEGER NOT NULL DEFAULT 0`);
        }
        db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)').run(
          SCHEMA_VERSION,
          this.now().toISOString(),
        );
        db.exec('COMMIT');
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* mantém o erro original */
        }
        throw error;
      }
    }
    this.db = db;
  }

  close(): void {
    try {
      this.db?.close();
    } finally {
      this.db = null; this.temporaryConversations.clear();
      if (this.temporarySweep) clearInterval(this.temporarySweep);
      this.temporarySweep = null;
      this.masterKey?.fill(0);
      this.masterKey = null;
    }
  }

  /** Força checkpoint do WAL (usado antes de verificações de ausência de claro). */
  checkpoint(): void {
    this.database.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  }

  private get database(): DatabaseSync {
    this.open();
    return this.db!;
  }

  /** Transação manual (node:sqlite não expõe helper .transaction). */
  private txn<T>(operation: () => T): T {
    if (this.inTransaction) return operation();
    const db = this.database;
    this.inTransaction = true;
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* mantém o erro original */
      }
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }
  private serial<T>(key: string, operation: () => T): T {
    // node:sqlite é síncrono e o Node é single-thread: cada bloco sync abaixo
    // é atômico contra interleavings; transações cobrem multi-statement.
    // A chave nomeia o dono lógico para auditoria futura.
    void key;
    return operation();
  }

  private async ensureKey(): Promise<Buffer> {
    if (this.masterKey) return this.masterKey;
    if (this.masterKeyPromise) return this.masterKeyPromise;
    this.masterKeyPromise = (async () => {
      try {
        let encoded: string | undefined;
        try {
          encoded = await this.secrets.get(CONVERSATION_KEY_ACCOUNT);
        } catch (error) {
          if (error instanceof Error && error.message === 'secret_store_read_unavailable') throw error;
          throw new WorkspaceError('conversation_key_unavailable', 503);
        }
        if (!encoded) {
          encoded = randomBytes(32).toString('base64url');
          try {
            await this.secrets.set(CONVERSATION_KEY_ACCOUNT, encoded);
          } catch {
            throw new WorkspaceError('conversation_key_unavailable', 503);
          }
        }
        const key = Buffer.from(encoded, 'base64url');
        if (key.length !== 32 || key.toString('base64url') !== encoded) {
          throw new WorkspaceError('conversation_key_invalid', 503);
        }
        this.masterKey = key;
        return key;
      } finally {
        this.masterKeyPromise = null;
      }
    })();
    return this.masterKeyPromise;
  }

  private conversationKey(master: Buffer, conversationId: string): Buffer {
    return Buffer.from(hkdfSync('sha256', master, conversationId, 'uptokey-conversation-v1', 32));
  }

  private seal(master: Buffer, principalId: string, conversationId: string, kind: string, plaintext: Uint8Array) {
    const key = this.conversationKey(master, conversationId);
    try {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(Buffer.from(`${principalId}|${conversationId}|${kind}`, 'utf8'));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return {
        nonce: nonce.toString('base64url'),
        ciphertext: ciphertext.toString('base64url'),
        tag: cipher.getAuthTag().toString('base64url'),
      };
    } finally {
      key.fill(0);
    }
  }

  private openSealed(
    master: Buffer,
    principalId: string,
    conversationId: string,
    kind: string,
    sealed: { nonce: string; ciphertext: string; tag: string },
  ): Buffer {
    const key = this.conversationKey(master, conversationId);
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.nonce, 'base64url'), {
        authTagLength: 16,
      });
      decipher.setAAD(Buffer.from(`${principalId}|${conversationId}|${kind}`, 'utf8'));
      decipher.setAuthTag(Buffer.from(sealed.tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, 'base64url')), decipher.final()]);
    } finally {
      key.fill(0);
    }
  }

  // ------------------------------------------------------------------ leitura

  private expireTemporaryConversations(): void {
    const now = this.now().getTime();
    for (const [id, temp] of this.temporaryConversations) {
      if (!this.queues.has(id) && now - temp.lastAccessAt >= TEMPORARY_CONVERSATION_IDLE_MS) {
        this.temporaryConversations.delete(id);
        // Session ended by expiry: the owner releases its ephemeral budget the same way deletion does.
        this.onTemporaryConversationEnded?.(temp.principalId, id);
      }
    }
    if (!this.temporaryConversations.size && this.temporarySweep) {
      clearInterval(this.temporarySweep);
      this.temporarySweep = null;
    }
  }

  private readConversationRow(principalId: string, conversationId: string): Record<string, unknown> {
    this.expireTemporaryConversations();
    const temp = this.temporaryConversations.get(conversationId);
    if (temp) {
      if (temp.principalId !== principalId) throw new WorkspaceError('conversation_not_found', 404);
      temp.lastAccessAt = this.now().getTime();
      return {
        id: temp.conversation.id,
        principal_id: temp.principalId,
        workspace_id: temp.conversation.workspaceId,
        project_id: temp.conversation.projectId ?? null,
        title: temp.conversation.title,
        created_at: temp.conversation.createdAt,
        updated_at: temp.conversation.updatedAt,
        revision: temp.conversation.revision,
        archived_at: temp.conversation.archivedAt ?? null,
        active_branch_id: temp.conversation.activeBranchId,
        storage_policy: temp.storagePolicy,
        processing_policy: temp.processingPolicy,
        cloud_sync_opt_in: 0,
      };
    }
    const row = this.database
      .prepare('SELECT * FROM conversations WHERE id=? AND principal_id=?')
      .get(conversationId, principalId) as Record<string, unknown> | undefined;
    if (!row) throw new WorkspaceError('conversation_not_found', 404);
    return row;
  }

  private rowToView(row: Record<string, unknown>) {
    return parseConversation({
      schemaVersion: CONVERSATION_SCHEMA_VERSION,
      id: row.id,
      workspaceId: row.workspace_id,
      projectId: row.project_id ?? null,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      revision: row.revision,
      archivedAt: row.archived_at ?? null,
      activeBranchId: row.active_branch_id,
      // Política persistida (v2); linhas antigas usam os defaults da migração.
      ...(row.storage_policy !== undefined && row.storage_policy !== null
        ? {
            storagePolicy: row.storage_policy,
            processingPolicy: row.processing_policy,
            cloudSyncOptIn: Number(row.cloud_sync_opt_in ?? 0) === 1,
          }
        : {}),
      ...(row.instruction_profile_ref ? { instructionProfileRef: row.instruction_profile_ref } : {}),
      ...(row.instruction_profile_rev ? { instructionProfileRevision: row.instruction_profile_rev } : {}),
    });
  }

  async createConversation(
    principalId: string,
    input: {
      title?: unknown;
      projectId?: unknown;
      storagePolicy?: unknown;
      processingPolicy?: unknown;
      cloudSyncOptIn?: unknown;
    },
    revalidate?: () => Promise<void>,
  ): Promise<ReturnType<typeof parseConversation>> {
    const master = await this.ensureKey();
    void master;
    await revalidate?.();
    if (input.title !== undefined && typeof input.title !== 'string') throw new WorkspaceError('conversation_invalid');
    let title = 'Nova conversa';
    if (typeof input.title === 'string' && input.title.trim()) {
      const length = [...input.title.trim()].length;
      if (length > 160) throw new WorkspaceError('conversation_invalid');
      title = input.title.trim();
    }
    let projectId: string | null = null;
    if (input.projectId !== undefined && input.projectId !== null) {
      if (typeof input.projectId !== 'string') throw new WorkspaceError('conversation_invalid');
      projectId = input.projectId;
      parseConversation({
        schemaVersion: 1, id: randomUUID(), workspaceId: workspaceIdFor(principalId), projectId,
        title, createdAt: this.now().toISOString(), updatedAt: this.now().toISOString(),
        revision: 1, archivedAt: null, activeBranchId: 'main',
      });
    }
    const storagePolicy: StoragePolicy = (input.storagePolicy as StoragePolicy) ?? 'local';
    const processingPolicy: ProcessingPolicy = (input.processingPolicy as ProcessingPolicy) ?? 'local_only';
    if (!['local', 'temporary', 'cloud'].includes(storagePolicy)) throw new WorkspaceError('conversation_invalid');
    if (!['local_only', 'external_allowed'].includes(processingPolicy)) throw new WorkspaceError('conversation_invalid');

    if (storagePolicy === 'cloud' && input.cloudSyncOptIn !== true) {
      throw new WorkspaceError('cloud_sync_not_opted_in', 403);
    }
    // Invariante do contrato: adesão à nuvem só existe junto de storagePolicy 'cloud'.
    if (input.cloudSyncOptIn === true && storagePolicy !== 'cloud') {
      throw new WorkspaceError('conversation_invalid');
    }

    const now = this.now().toISOString();
    const id = randomUUID();
    const conv = parseConversation({
      schemaVersion: 1, id, workspaceId: workspaceIdFor(principalId), projectId,
      title, createdAt: now, updatedAt: now, revision: 1, archivedAt: null, activeBranchId: 'main',
      storagePolicy, processingPolicy, cloudSyncOptIn: storagePolicy === 'cloud',
    });

    if (storagePolicy === 'temporary') {
      this.temporaryConversations.set(id, {
        principalId,
        lastAccessAt: this.now().getTime(),
        conversation: conv,
        storagePolicy: 'temporary',
        processingPolicy,
        messages: new Map(),
        events: [],
        runLinks: new Map(),
        admissions: new Map(),
        outbox: [],
      });
      if (!this.temporarySweep) {
        this.temporarySweep = setInterval(() => this.expireTemporaryConversations(), 60_000);
        this.temporarySweep.unref();
      }
      return conv;
    }

    // A fonte canônica da política é o banco (colunas persistidas); 'cloud'
    // registra apenas a intenção — não existe backend remoto nem upload.
    this.database
      .prepare(
        `INSERT INTO conversations(id, principal_id, workspace_id, project_id, title, created_at, updated_at,
          revision, archived_at, active_branch_id, storage_policy, processing_policy, cloud_sync_opt_in)
         VALUES(?, ?, ?, ?, ?, ?, ?, 1, NULL, 'main', ?, ?, ?)`,
      )
      .run(
        id, principalId, workspaceIdFor(principalId), projectId, title, now, now,
        storagePolicy, processingPolicy, storagePolicy === 'cloud' ? 1 : 0,
      );
    return this.rowToView(this.readConversationRow(principalId, id));
  }

  async listConversations(principalId: string, query: { after?: unknown; limit?: unknown; query?: unknown; includeArchived?: unknown }, projects: LocalProjectGrant = '*') {
    let parsed;
    try {
      parsed = parseListQuery({
        after: query.after ?? null, limit: query.limit ?? null,
        query: query.query ?? null, includeArchived: query.includeArchived ?? false,
      });
    } catch (error) {
      throw toWorkspaceError(error);
    }
    const db = this.database;
    const conditions = ['principal_id=?'];
    const params: unknown[] = [principalId];
    const projectClause = projects === '*' ? '' : projects.length ? ` AND project_id IN (${projects.map(()=>'?').join(',')})` : ' AND 0';
    const projectParams = projects === '*' ? [] : [...projects];
    conditions.push('1'+projectClause);params.push(...projectParams);
    if (!parsed.includeArchived) conditions.push('archived_at IS NULL');
    if (parsed.query) {
      conditions.push('title LIKE ? ESCAPE ?');
      params.push(`%${(parsed.query as string).replace(/[\\%_]/g, (c) => `\\${c}`)}%`, '\\');
    }
    if (parsed.after) {
      const anchor = db.prepare('SELECT updated_at, id FROM conversations WHERE id=? AND principal_id=?'+projectClause).get(
        parsed.after, principalId, ...projectParams,
      ) as { updated_at: string; id: string } | undefined;
      if (anchor) {
        conditions.push('(updated_at < ? OR (updated_at = ? AND id < ?))');
        params.push(anchor.updated_at, anchor.updated_at, anchor.id);
      }
    }
    const rows = db
      .prepare(
        `SELECT * FROM conversations WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC, id DESC LIMIT ?`,
      )
      .all(...(params as SQLInputValue[]), parsed.limit + 1) as Record<string, unknown>[];
    const page = rows.slice(0, parsed.limit);
    return {
      conversations: page.map((row) => this.rowToView(row)),
      nextCursor: rows.length > parsed.limit ? (page.at(-1)!.id as string) : null,
    };
  }

  async getConversation(principalId: string, conversationId: string) {
    return this.rowToView(this.readConversationRow(principalId, conversationId));
  }

  async updateConversation(
    principalId: string,
    conversationId: string,
    input: {
      expectedRevision: unknown;
      title?: unknown;
      activeBranchId?: unknown;
      archive?: unknown;
      instructionProfileRef?: unknown;
      instructionProfileRevision?: unknown;
      policy?: unknown;
    },
    revalidate?: () => Promise<void>,
  ) {
    await this.ensureKey();
    await revalidate?.();
    return this.serial(`conv:${conversationId}`, () => {
      const row = this.readConversationRow(principalId, conversationId);
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision !== row.revision) {
        throw new WorkspaceError('conversation_conflict', 409);
      }
      const patch: {
        title?: string; activeBranchId?: string; archived?: boolean;
        instructionProfileRef?: string | null; instructionProfileRevision?: number | null;
        storagePolicy?: StoragePolicy; processingPolicy?: ProcessingPolicy; cloudSyncOptIn?: boolean;
        policyRevoked?: 'cloud_sync';
      } = {};
      if (input.policy !== undefined) {
        let policyPatch;
        try {
          policyPatch = parseConversationPolicyPatch(input.policy);
        } catch (error) {
          throw toWorkspaceError(error);
        }
        const temp = this.temporaryConversations.get(conversationId);
        if (temp) {
          // 'temporary' é decisão de criação: não vira permanente nem nuvem
          // por patch. Apenas o processingPolicy alterna livremente.
          if (policyPatch.storagePolicy !== undefined || policyPatch.cloudSyncOptIn !== undefined) {
            throw new WorkspaceError('conversation_invalid');
          }
          patch.processingPolicy = policyPatch.processingPolicy;
        } else {
          const currentStorage = (row.storage_policy as StoragePolicy | undefined) ?? 'local';
          const currentProcessing = (row.processing_policy as ProcessingPolicy | undefined) ?? 'local_only';
          const currentOptIn = Number(row.cloud_sync_opt_in ?? 0) === 1;
          const nextStorage = policyPatch.storagePolicy ?? currentStorage;
          const nextProcessing = policyPatch.processingPolicy ?? currentProcessing;
          let nextOptIn = currentOptIn;
          if (policyPatch.cloudSyncOptIn !== undefined) nextOptIn = policyPatch.cloudSyncOptIn;
          // Revogar a nuvem (cloud → local) zera a adesão; subir para 'cloud'
          // sem opt-in no mesmo patch já foi recusado pelo parser.
          if (nextStorage === 'local') nextOptIn = false;
          if (nextStorage === 'cloud' && nextOptIn !== true) {
            throw new WorkspaceError('cloud_sync_not_opted_in', 403);
          }
          if (nextOptIn && nextStorage !== 'cloud') throw new WorkspaceError('conversation_invalid');
          patch.storagePolicy = nextStorage;
          patch.processingPolicy = nextProcessing;
          patch.cloudSyncOptIn = nextOptIn;
          if (currentStorage === 'cloud' && nextStorage === 'local') {
            // Revogação: registra o evento e persiste o novo estado. Não há
            // backend remoto nem marcação de upload na outbox — nenhuma
            // intenção local deixa de existir por causa desta mudança.
            patch.policyRevoked = 'cloud_sync';
          }
        }
      }
      if (input.title !== undefined) {
        if (typeof input.title !== 'string') throw new WorkspaceError('conversation_invalid');
        const trimmed = input.title.trim();
        const length = [...trimmed].length;
        if (length < 1 || length > 160) throw new WorkspaceError('conversation_invalid');
        patch.title = trimmed;
      }
      if (input.activeBranchId !== undefined) {
        if (typeof input.activeBranchId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(input.activeBranchId)) {
          throw new WorkspaceError('conversation_invalid');
        }
        patch.activeBranchId = input.activeBranchId;
      }
      if (input.archive !== undefined) {
        if (typeof input.archive !== 'boolean') throw new WorkspaceError('conversation_invalid');
        patch.archived = input.archive;
      }
      if (input.instructionProfileRef !== undefined) {
        if (input.instructionProfileRef !== null && typeof input.instructionProfileRef !== 'string') {
          throw new WorkspaceError('conversation_invalid');
        }
        patch.instructionProfileRef = input.instructionProfileRef;
      }
      if (input.instructionProfileRevision !== undefined) {
        if (
          input.instructionProfileRevision !== null &&
          (!Number.isSafeInteger(input.instructionProfileRevision) || (input.instructionProfileRevision as number) < 1)
        ) {
          throw new WorkspaceError('conversation_invalid');
        }
        patch.instructionProfileRevision = input.instructionProfileRevision as number | null;
      }
      const now = this.now().toISOString();
      const temp = this.temporaryConversations.get(conversationId);
      if (temp) {
        const nextProcessing = (patch.processingPolicy as ProcessingPolicy | undefined) ?? temp.processingPolicy;
        const next = parseConversation({
          ...temp.conversation,
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.activeBranchId !== undefined ? { activeBranchId: patch.activeBranchId } : {}),
          ...(patch.archived !== undefined ? { archivedAt: patch.archived ? now : null } : {}),
          ...(patch.instructionProfileRef !== undefined ? { instructionProfileRef: patch.instructionProfileRef } : {}),
          ...(patch.instructionProfileRevision !== undefined ? { instructionProfileRevision: patch.instructionProfileRevision } : {}),
          storagePolicy: 'temporary', processingPolicy: nextProcessing, cloudSyncOptIn: false,
          updatedAt: now, revision: temp.conversation.revision + 1,
        });
        temp.conversation = next;
        temp.processingPolicy = nextProcessing;
        this.appendEventRow(principalId, conversationId, {
          runId: null, type: patch.archived === true ? 'conversation.archived' : 'conversation.updated',
          payload: { revision: next.revision },
        });
        return next;
      }
      this.database
        .prepare(
          `UPDATE conversations SET title=COALESCE(?, title), active_branch_id=COALESCE(?, active_branch_id),
            archived_at=CASE WHEN ? IS NULL THEN archived_at WHEN ? = 1 THEN ? ELSE NULL END,
            instruction_profile_ref=COALESCE(?, instruction_profile_ref),
            instruction_profile_rev=COALESCE(?, instruction_profile_rev),
            storage_policy=COALESCE(?, storage_policy),
            processing_policy=COALESCE(?, processing_policy),
            cloud_sync_opt_in=COALESCE(?, cloud_sync_opt_in),
            updated_at=?, revision=revision+1
           WHERE id=? AND principal_id=? AND revision=?`,
        )
        .run(
          patch.title ?? null, patch.activeBranchId ?? null,
          (patch.archived === undefined ? null : 0) as SQLInputValue, (patch.archived === undefined ? null : patch.archived ? 1 : 0) as SQLInputValue, now,
          patch.instructionProfileRef ?? null, patch.instructionProfileRevision ?? null,
          (patch.storagePolicy ?? null) as SQLInputValue, (patch.processingPolicy ?? null) as SQLInputValue,
          (patch.cloudSyncOptIn === undefined ? null : patch.cloudSyncOptIn ? 1 : 0) as SQLInputValue,
          now, conversationId, principalId, Number(row.revision),
        );
      const updated = this.rowToView(this.readConversationRow(principalId, conversationId));
      this.appendEventRow(principalId, conversationId, {
        runId: null, type: patch.archived === true ? 'conversation.archived' : 'conversation.updated',
        payload: {
          revision: updated.revision,
          ...(patch.policyRevoked ? { policyRevoked: patch.policyRevoked } : {}),
        },
      });
      return updated;
    });
  }

  async deleteConversation(principalId: string, conversationId: string, expectedRevision: unknown, revalidate?:()=>Promise<void>) {
    this.readConversationRow(principalId, conversationId);
    return this.serializeRun(conversationId, async()=>{
      const temp=this.temporaryConversations.get(conversationId);
      const admissions=temp?[...temp.admissions.values()]:this.database.prepare('SELECT project_id AS projectId, run_request_id AS runRequestId FROM conversation_run_admissions WHERE conversation_id=?').all(conversationId) as unknown as Array<{projectId:string;runRequestId:string}>;
      for(const admission of admissions){
        if(!this.runRequestAuthority)throw new WorkspaceError('run_authority_unavailable',503);
        const run=await this.runRequestAuthority(principalId,admission.projectId,admission.runRequestId);
        if(run&&!TERMINAL_RUN_STATES.has(conversationStateFromRunStatus(run.status)))throw new WorkspaceError('conversation_conflict',409);
      }
      // All asynchronous admission reads precede the last authorization check.
      // The revision check and SQLite mutation that follow remain synchronous.
      await revalidate?.();
      return this.deleteConversationSerial(principalId,conversationId,expectedRevision);
    });
  }

  private deleteConversationSerial(principalId: string, conversationId: string, expectedRevision: unknown) {
    return this.serial(`conv:${conversationId}`, () => {
      const row = this.readConversationRow(principalId, conversationId);
      if (this.temporaryConversations.has(conversationId)) {
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== row.revision) {
          throw new WorkspaceError('conversation_conflict', 409);
        }
        this.temporaryConversations.delete(conversationId);
        return { deleted: true, conversationId };
      }
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== row.revision) {
        throw new WorkspaceError('conversation_conflict', 409);
      }
      const active = this.database
        .prepare(
          `SELECT request_id FROM run_links WHERE conversation_id=? AND state IN ('queued','streaming','awaiting_action') LIMIT 1`,
        )
        .get(conversationId) as { request_id: string } | undefined;
      if (active) throw new WorkspaceError('conversation_conflict', 409);
      const db = this.database;
      const messageIds = (
        db.prepare('SELECT id FROM messages WHERE conversation_id=?').all(conversationId) as { id: string }[]
      ).map((m) => m.id);
      this.txn(() => {
        for (const messageId of messageIds) {
          db.prepare('DELETE FROM message_parts WHERE message_id=?').run(messageId);
        }
        db.prepare('DELETE FROM messages WHERE conversation_id=?').run(conversationId);
        db.prepare('DELETE FROM run_links WHERE conversation_id=?').run(conversationId);
        db.prepare('DELETE FROM conversation_events WHERE conversation_id=?').run(conversationId);
        db.prepare('DELETE FROM conversation_outbox WHERE conversation_id=?').run(conversationId);
        db.prepare('DELETE FROM conversation_run_admissions WHERE conversation_id=?').run(conversationId);
        db.prepare('DELETE FROM conversations WHERE id=? AND principal_id=?').run(conversationId, principalId);
      });
      return { deleted: true, conversationId };
    });
  }

  async continuityRuns(principalId: string, conversationId: string) {
    await this.ensureKey();
    const conversation = this.rowToView(this.readConversationRow(principalId, conversationId));
    const temporary = this.temporaryConversations.get(conversationId);
    const links = temporary ? [...temporary.runLinks.values()] :
      (this.database.prepare('SELECT * FROM run_links WHERE conversation_id=? LIMIT 1001').all(conversationId) as Record<string, unknown>[]).map(row => this.linkView(row));
    if (links.length > 1000) throw new WorkspaceError('continuity_too_large', 422);
    const runs = [];
    for (const link of links) {
      const observed = await this.authoritativeRun(principalId, link);
      const state = conversationStateFromRunStatus(observed.status);
      const admission = this.admission(conversationId, link.requestId)!;
      runs.push({messageId:link.messageId,runId:link.runId,projectId:link.projectId,requestId:link.requestId,planId:admission.planId,planDigest:admission.planDigest,state,
        ...(observed.stepStates ? {steps:observed.stepStates.map(step=>({stepId:step.stepId,status:step.status,receiptIds:step.receiptIds}))} : {}),
        ...(observed.receipts ? {receipts:observed.receipts.map(receipt=>({id:receipt.id,stepId:receipt.stepId,status:receipt.status,outputArtifactRefs:receipt.outputArtifactRefs}))} : {})});
    }
    return {schemaVersion:1 as const,conversationId,revision:conversation.revision,branchId:conversation.activeBranchId,runs};
  }

  async exportConversation(principalId: string, conversationId: string) {
    const master = await this.ensureKey();
    const conversation = this.rowToView(this.readConversationRow(principalId, conversationId));
    // Exporta tudo por página de 200 (teto do parser) até esgotar o cursor.
    const messages: ReturnType<typeof parseMessage & { parts?: unknown }>[] = [];
    let after: string | null = null;
    for (;;) {
      const page = await this.listMessages(principalId, conversationId, { after, limit: 200 });
      messages.push(...(page.messages as (typeof messages)[number][]));
      if (!page.nextCursor) break;
      after = page.nextCursor;
    }
    const temporary = this.temporaryConversations.get(conversationId);
    const runLinks = temporary ? Array.from(temporary.runLinks.values()) : (
      this.database.prepare('SELECT * FROM run_links WHERE conversation_id=?').all(conversationId) as Record<
        string, unknown
      >[]
    ).map((row) =>
      parseRunLink({
        conversationId, messageId: row.message_id, requestId: row.request_id, runId: row.run_id,
        projectId: row.project_id, providerId: row.provider_id ?? null, accountRef: row.account_ref ?? null,
        modelId: row.model_id, state: row.state, lastSequence: row.last_sequence,
      }),
    );
    void master;
    return {
      schemaVersion: 1 as const,
      exportedAt: this.now().toISOString(),
      includesInstructions: Boolean(conversation.instructionProfileRef),
      conversation,
      messages,
      runLinks,
    };
  }

  // --------------------------------------------------------------- mensagens

  async appendMessage(principalId: string, conversationId: string, input: unknown, revalidate?: () => Promise<void>) {
    const master = await this.ensureKey();
    await revalidate?.();
    const raw = (input ?? {}) as Record<string, unknown>;
    // Extensão de serviço (fora do W0 Send): `role` no topo permite persistir
    // respostas recebidas (assistant/tool); o padrão é `user` com outbox.
    const role = raw.role === undefined || raw.role === null ? 'user' : raw.role;
    if (role !== 'user' && role !== 'assistant' && role !== 'tool') {
      throw new WorkspaceError('conversation_invalid');
    }
    let send;
    try {
      const { role: _serviceRole, ...sendFields } = raw;
      void _serviceRole;
      send = parseSendMessage({ ...sendFields, conversationId });
    } catch (error) {
      throw toWorkspaceError(error);
    }
    return this.serial(`conv:${conversationId}`, () => {
      this.readConversationRow(principalId, conversationId);
      const temp = this.temporaryConversations.get(conversationId);
      if (temp) {
        if (temp.conversation.archivedAt) throw new WorkspaceError('conversation_conflict', 409);
        for (const existing of temp.messages.values()) {
          if (existing.message.clientMessageId === send.clientMessageId) {
            const bodyDigest = createHash('sha256')
              .update(canonicalJson({ parts: send.parts, parentId: send.parentId, role }))
              .digest('hex');
            if (existing.bodyDigest === bodyDigest) {
              return { message: existing.message, parts: existing.parts, requestId: existing.outboxRequestId, duplicate: true as const, conversationRevision: temp.conversation.revision };
            }
            throw new WorkspaceError('message_conflict', 409);
          }
        }
        if (send.expectedRevision !== temp.conversation.revision) throw new WorkspaceError('conversation_conflict', 409);
        if (temp.messages.size >= CONVERSATION_MAX_MESSAGES_PER_CONVERSATION) {
          throw new WorkspaceError('conversation_limit_exceeded', 409);
        }
        if (send.parentId && !temp.messages.has(send.parentId)) {
          throw new WorkspaceError('message_not_found', 404);
        }
        const messageId = randomUUID();
        const createdAt = this.now().toISOString();
        const branchId = temp.conversation.activeBranchId;
        const bodyDigest = createHash('sha256')
          .update(canonicalJson({ parts: send.parts, parentId: send.parentId, role }))
          .digest('hex');
        const parts = send.parts.map((raw) => this.buildPart(messageId, raw).view);
        let requestId: string | null = null;
        if (role === 'user') {
          requestId = `creq_${randomUUID()}`;
          temp.outbox.push({
            requestId, conversationId, messageId, state: 'queued', attempts: 0,
            createdAt, updatedAt: createdAt,
          });
        }
        const message = parseMessage({
          schemaVersion: 1, id: messageId, conversationId, parentId: send.parentId, branchId,
          role, clientMessageId: send.clientMessageId, createdAt, revision: 1,
        });
        temp.messages.set(messageId, { message, parts, bodyDigest, outboxRequestId: requestId });
        temp.conversation = parseConversation({
          ...temp.conversation,
          updatedAt: createdAt,
          revision: temp.conversation.revision + 1,
        });
        this.appendEventRow(principalId, conversationId, {
          runId: null, type: 'message.created', payload: { messageId, requestId },
        });
        return { message, parts, requestId, duplicate: false as const, conversationRevision: temp.conversation.revision };
      }
      const db = this.database;
      const row = this.readConversationRow(principalId, conversationId);
      if (row.archived_at) throw new WorkspaceError('conversation_conflict', 409);
      const existing = db
        .prepare('SELECT id FROM messages WHERE conversation_id=? AND client_message_id=?')
        .get(conversationId, send.clientMessageId) as { id: string } | undefined;
      const bodyDigest = createHash('sha256')
        .update(canonicalJson({ parts: send.parts, parentId: send.parentId, role }))
        .digest('hex');
      if (existing) {
        const current = this.readMessageRow(principalId, conversationId, existing.id, master);
        if (current.bodyDigest === bodyDigest) {
          return { message: current.message, parts: current.parts, requestId: current.outboxRequestId, duplicate: true as const, conversationRevision: row.revision };
        }
        throw new WorkspaceError('message_conflict', 409);
      }
      if (send.expectedRevision !== row.revision) throw new WorkspaceError('conversation_conflict', 409);
      const count = (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id=?').get(conversationId) as {
        n: number;
      }).n;
      if (count >= CONVERSATION_MAX_MESSAGES_PER_CONVERSATION) {
        throw new WorkspaceError('conversation_limit_exceeded', 409);
      }
      if (send.parentId) {
        const parent = db
          .prepare('SELECT id FROM messages WHERE id=? AND conversation_id=?')
          .get(send.parentId, conversationId) as { id: string } | undefined;
        if (!parent) throw new WorkspaceError('message_not_found', 404);
      }
      // Valida todas as partes antes de persistir qualquer linha.
      const messageId = randomUUID();
      const createdAt = this.now().toISOString();
      const sealed = this.seal(
        master, principalId, conversationId, 'message',
        Buffer.from(canonicalJson({ bodyDigest, role }), 'utf8'),
      );
      const branchId = (row.active_branch_id as string) ?? 'main';
      const { parts, requestId } = this.txn(() => {
        db.prepare(
          `INSERT INTO messages(id, conversation_id, parent_id, branch_id, role, client_message_id,
            created_at, revision, sealed_nonce, sealed_ciphertext, sealed_tag)
           VALUES(?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        ).run(
          messageId, conversationId, send.parentId, branchId, role, send.clientMessageId,
          createdAt, sealed.nonce, sealed.ciphertext, sealed.tag,
        );
        const builtParts = send.parts.map((raw) => {
          const part = this.buildPart(messageId, raw);
          const partSealed = this.seal(
            master, principalId, conversationId, 'part',
            Buffer.from(canonicalJson(this.partPayload(part)), 'utf8'),
          );
          db.prepare(
            `INSERT INTO message_parts(id, message_id, type, artifact_ref, call_id, name,
              sealed_nonce, sealed_ciphertext, sealed_tag) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            part.id, messageId, part.type, part.artifactRef, part.callId, part.name,
            partSealed.nonce, partSealed.ciphertext, partSealed.tag,
          );
          return part.view;
        });
        db.prepare('UPDATE conversations SET updated_at=?, revision=revision+1 WHERE id=? AND principal_id=?').run(
          createdAt, conversationId, principalId,
        );
        let outboxReqId: string | null = null;
        if (role === 'user') {
          outboxReqId = `creq_${randomUUID()}`;
          db.prepare(
            `INSERT INTO conversation_outbox(request_id, conversation_id, message_id, state, attempts, created_at, updated_at)
             VALUES(?, ?, ?, 'queued', 0, ?, ?)`,
          ).run(outboxReqId, conversationId, messageId, createdAt, createdAt);
        }
        this.appendEventRow(principalId, conversationId, {
          runId: null, type: 'message.created', payload: { messageId, requestId: outboxReqId },
        });
        return { parts: builtParts, requestId: outboxReqId };
      });
      const message = parseMessage({
        schemaVersion: 1, id: messageId, conversationId, parentId: send.parentId, branchId,
        role, clientMessageId: send.clientMessageId, createdAt, revision: 1,
      });
      return { message, parts, requestId, duplicate: false as const, conversationRevision: row.revision + 1 };
    });
  }

  private buildPart(messageId: string, raw: unknown) {
    const probe = (raw ?? {}) as Record<string, unknown>;
    const { role: _roleHint, ...partFields } = probe;
    void _roleHint;
    const withIds = { ...partFields, id: randomUUID(), messageId };
    let parsed;
    try {
      parsed = parseMessagePart(withIds);
    } catch (error) {
      throw toWorkspaceError(error);
    }
    return {
      id: parsed.id,
      type: parsed.type,
      artifactRef: parsed.artifactRef ?? null,
      callId: parsed.callId ?? null,
      name: parsed.name ?? null,
      view: parsed,
    };
  }

  private partPayload(part: { view: ReturnType<typeof parseMessagePart> }) {
    const view = part.view;
    return { type: view.type, text: view.text ?? null, artifactRef: view.artifactRef ?? null };
  }

  private readMessageRow(
    principalId: string, conversationId: string, messageId: string, master: Buffer,
  ): { message: ReturnType<typeof parseMessage>; parts: ReturnType<typeof parseMessagePart>[]; bodyDigest: string; outboxRequestId: string | null } {
    const db = this.database;
    const row = db.prepare('SELECT * FROM messages WHERE id=? AND conversation_id=?').get(messageId, conversationId) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new WorkspaceError('message_not_found', 404);
    const body = JSON.parse(
      this.openSealed(master, principalId, conversationId, 'message', {
        nonce: row.sealed_nonce as string, ciphertext: row.sealed_ciphertext as string, tag: row.sealed_tag as string,
      }).toString('utf8'),
    ) as { bodyDigest: string; role: 'user' | 'assistant' | 'tool' };
    const message = parseMessage({
      schemaVersion: 1, id: row.id, conversationId, parentId: row.parent_id ?? null, branchId: row.branch_id,
      role: body.role, clientMessageId: row.client_message_id, createdAt: row.created_at, revision: row.revision,
    });
    const partRows = db.prepare('SELECT * FROM message_parts WHERE message_id=?').all(messageId) as Record<
      string, unknown
    >[];
    const parts = partRows.map((partRow) => {
      const payload = JSON.parse(
        this.openSealed(master, principalId, conversationId, 'part', {
          nonce: partRow.sealed_nonce as string, ciphertext: partRow.sealed_ciphertext as string,
          tag: partRow.sealed_tag as string,
        }).toString('utf8'),
      ) as { type: string; text: unknown; artifactRef: string | null };
      return parseMessagePart({
        id: partRow.id, messageId, type: partRow.type, text: payload.text ?? undefined,
        artifactRef: partRow.artifact_ref ?? payload.artifactRef ?? undefined,
        callId: partRow.call_id ?? undefined, name: partRow.name ?? undefined,
      });
    });
    const outbox = db.prepare('SELECT request_id FROM conversation_outbox WHERE message_id=?').get(messageId) as
      | { request_id: string }
      | undefined;
    return { message, parts, bodyDigest: body.bodyDigest, outboxRequestId: outbox?.request_id ?? null };
  }

  async listMessages(principalId: string, conversationId: string, query: { after?: unknown; limit?: unknown }) {
    const master = await this.ensureKey();
    let parsed;
    try {
      parsed = parseListQuery({ after: query.after ?? null, limit: query.limit ?? null, query: null, includeArchived: true });
    } catch (error) {
      throw toWorkspaceError(error);
    }
    this.readConversationRow(principalId, conversationId);
    const temp = this.temporaryConversations.get(conversationId);
    if (temp) {
      const allMessages = Array.from(temp.messages.values());
      let startIndex = 0;
      if (parsed.after) {
        const idx = allMessages.findIndex((m) => m.message.id === parsed.after);
        if (idx >= 0) startIndex = idx + 1;
      }
      const slice = allMessages.slice(startIndex, startIndex + parsed.limit);
      return {
        messages: slice.map((m) => ({ ...m.message, parts: m.parts })),
        nextCursor: allMessages.length > startIndex + parsed.limit ? slice.at(-1)!.message.id : null,
      };
    }
    const db = this.database;
    // Ordem de inserção real (rowid): sem depender de timestamps nem fabricar
    // carimbos para preservar ordem; cursor ancorado no rowid da âncora.
    let anchorRowid = 0;
    if (parsed.after) {
      const anchorRow = db
        .prepare('SELECT rowid FROM messages WHERE id=? AND conversation_id=?')
        .get(parsed.after, conversationId) as { rowid: number | bigint } | undefined;
      if (anchorRow) anchorRowid = Number(anchorRow.rowid);
    }
    const rows = db
      .prepare('SELECT id FROM messages WHERE conversation_id=? AND rowid > ? ORDER BY rowid ASC LIMIT ?')
      .all(conversationId, anchorRowid, parsed.limit + 1) as { id: string }[];
    const page = rows.slice(0, parsed.limit);
    const messages = page.map((row) => {
      const full = this.readMessageRow(principalId, conversationId, row.id, master);
      return { ...full.message, parts: full.parts };
    });
    return { messages, nextCursor: rows.length > parsed.limit ? (page.at(-1)!.id as string) : null };
  }

  /**
   * Busca textual no processo autorizado (spec E2-01): decifra e filtra em
   * memória, sem índice em claro no banco/WAL. Varredura limitada; snippet
   * curto derivado do conteúdo real, sem fabricação.
   */
  async searchMessages(principalId: string, input: { query: unknown; limit?: unknown }, projects: LocalProjectGrant = '*') {
    const master = await this.ensureKey();
    if (typeof input.query !== 'string' || input.query.trim().length < 2 || input.query.length > 200) {
      throw new WorkspaceError('conversation_invalid');
    }
    let limit = 20;
    if (input.limit !== undefined && input.limit !== null) {
      if (typeof input.limit !== 'number' || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
        throw new WorkspaceError('conversation_invalid');
      }
      limit = input.limit as number;
    }
    const needle = input.query.trim().toLowerCase();
    const db = this.database;
    const projectClause = projects === '*' ? '' : projects.length ? ` AND project_id IN (${projects.map(()=>'?').join(',')})` : ' AND 0';
    const conversations = db
      .prepare('SELECT id FROM conversations WHERE principal_id=?'+projectClause+' ORDER BY updated_at DESC, id DESC')
      .all(principalId,...(projects === '*' ? [] : projects)) as { id: string }[];
    const results: Array<{ conversationId: string; messageId: string; role: string; snippet: string }> = [];
    const SCAN_BUDGET = 20_000;
    let scanned = 0;
    for (const conversation of conversations) {
      if (results.length >= limit || scanned >= SCAN_BUDGET) break;
      let after: string | null = null;
      for (;;) {
        if (results.length >= limit || scanned >= SCAN_BUDGET) break;
        const page = await this.listMessages(principalId, conversation.id, { after, limit: 200 });
        scanned += page.messages.length;
        for (const message of page.messages) {
          for (const part of message.parts) {
            const text = typeof part.text === 'string' ? part.text : null;
            if (!text) continue;
            const index = text.toLowerCase().indexOf(needle);
            if (index < 0) continue;
            const start = Math.max(0, index - 40);
            const snippet = (start > 0 ? '…' : '') + text.slice(start, index + needle.length + 40).trim() +
              (index + needle.length + 40 < text.length ? '…' : '');
            results.push({ conversationId: conversation.id, messageId: message.id, role: message.role, snippet });
            break;
          }
          if (results.length >= limit) break;
        }
        if (!page.nextCursor) break;
        after = page.nextCursor;
      }
    }
    return { query: input.query.trim(), results, scanned, truncated: scanned >= SCAN_BUDGET };
  }

  // ------------------------------------------------------------------ runs

  /**
   * Core authority over run links (C28). When set, a link must reference a run
   * of the same principal/project in the workspace journal, and its state is the
   * journal's projection — a client cannot assert a terminal or bind a foreign run.
   */
  setRunAuthority(authority: RunAuthority | undefined, requestAuthority?: RunRequestAuthority): void {
    this.runAuthority = authority;
    this.runRequestAuthority = requestAuthority;
  }

  private async serializeRun<T>(conversationId: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(conversationId) ?? Promise.resolve()).catch(() => undefined).then(operation);
    this.queues.set(conversationId, next);
    try { return await next; } finally { if (this.queues.get(conversationId) === next) this.queues.delete(conversationId); }
  }

  private admission(conversationId: string, requestId: string): ConversationRunAdmission | undefined {
    const temp = this.temporaryConversations.get(conversationId);
    if (temp) return temp.admissions.get(requestId);
    return this.database.prepare(`SELECT principal_id AS principalId, conversation_id AS conversationId,
      message_id AS messageId, request_id AS requestId, project_id AS projectId, run_request_id AS runRequestId,
      plan_id AS planId, plan_digest AS planDigest FROM conversation_run_admissions WHERE request_id=? AND conversation_id=?`)
      .get(requestId, conversationId) as unknown as ConversationRunAdmission | undefined;
  }

  /**
   * Durable admission that bound an intention to a run. The HTTP guard verifies
   * `runs/start` replays against this row: a recovery must present the exact
   * admission (principal, project, intention, plan and digest), never a
   * reassignment of the run to another conversation or turn.
   */
  async readRunAdmission(principalId: string, conversationId: string, requestId: string): Promise<ConversationRunAdmission | undefined> {
    await this.ensureKey();
    const admission = this.admission(conversationId, requestId);
    if (!admission || admission.principalId !== principalId) return undefined;
    return { ...admission };
  }

  /**
   * Conversation scope of an already admitted run request. Descendant runs
   * (project-task children) reuse this identity so their reservations and
   * settlements land on the same budget ledger as the admitted root run.
   * Temporary admissions are memory-only and never touch disk here.
   */
  async conversationScopeForRunRequest(principalId: string, projectId: string, runRequestId: string): Promise<{ id: string; temporary: boolean } | undefined> {
    for (const [id, temporary] of this.temporaryConversations) {
      if ([...temporary.admissions.values()].some(admission => admission.principalId === principalId && admission.projectId === projectId && admission.runRequestId === runRequestId)) {
        return { id, temporary: true };
      }
    }
    const row = this.database.prepare('SELECT conversation_id AS conversationId FROM conversation_run_admissions WHERE principal_id=? AND project_id=? AND run_request_id=?')
      .get(principalId, projectId, runRequestId) as { conversationId: string } | undefined;
    if (!row) return undefined;
    try {
      const conversation = this.rowToView(this.readConversationRow(principalId, row.conversationId));
      return { id: row.conversationId, temporary: conversation.storagePolicy === 'temporary' };
    } catch {
      // A deleted or unreadable conversation must not fabricate a scope.
      return undefined;
    }
  }

  /** Called inside the runtime's project start queue, after authorization and all start gates.
   * The durable identity reservation precedes journal admission. These stores are not a distributed
   * transaction: an uncertain failure retains the reservation for an identical retry/recovery.
   */
  async withRunAdmission<T>(principalId: string, conversationId: string, requestId: string,
    projectId: string, command: { requestId: string; planId: string; planDigest: string }, start: () => Promise<T>): Promise<T> {
    await this.ensureKey();
    return this.serializeRun(conversationId, async () => {
      if (!this.runRequestAuthority) throw new WorkspaceError('run_authority_unavailable', 503);
      const intent = this.assertLinkAssociation(principalId, conversationId, { requestId, projectId });
      const proposed: ConversationRunAdmission = { principalId, conversationId, requestId, messageId: intent.messageId,
        projectId, runRequestId: command.requestId, planId: command.planId, planDigest: command.planDigest };
      const prior = this.admission(conversationId, requestId);
      if (prior && Object.keys(proposed).some(key => prior[key as keyof ConversationRunAdmission] !== proposed[key as keyof ConversationRunAdmission])) {
        throw new WorkspaceError('run_link_conflict', 409);
      }
      const existing = await this.runRequestAuthority(principalId, projectId, command.requestId);
      // A client cannot attach an old, unrelated run after it has already been admitted.
      if (!prior && (existing || intent.state !== 'queued')) throw new WorkspaceError('run_link_mismatch', 409);
      this.assertLinkAssociation(principalId, conversationId, proposed);
      if (!prior) {
        const temp = this.temporaryConversations.get(conversationId);
        const collision = [...this.temporaryConversations.values()].some(c => [...c.admissions.values()].some(a =>
          a.principalId === principalId && a.projectId === projectId && a.runRequestId === command.requestId));
        const durableCollision = this.db?.prepare('SELECT request_id FROM conversation_run_admissions WHERE principal_id=? AND project_id=? AND run_request_id=?')
          .get(principalId, projectId, command.requestId);
        if (collision || durableCollision) throw new WorkspaceError('run_link_conflict', 409);
        if (temp) temp.admissions.set(requestId, proposed);
        else this.txn(() => this.database.prepare(`INSERT INTO conversation_run_admissions
          (request_id,principal_id,conversation_id,message_id,project_id,run_request_id,plan_id,plan_digest) VALUES(?,?,?,?,?,?,?,?)`)
          .run(requestId, principalId, conversationId, proposed.messageId, projectId, command.requestId, command.planId, command.planDigest));
      }
      try { return await start(); } catch (error) {
        // Absence must be positively established. A failed lookup is an uncertain ACK, never a rollback.
        const admitted = await this.runRequestAuthority(principalId, projectId, command.requestId);
        if (!admitted) {
          const temp = this.temporaryConversations.get(conversationId);
          if (temp) temp.admissions.delete(requestId);
          else this.database.prepare('DELETE FROM conversation_run_admissions WHERE request_id=? AND conversation_id=?').run(requestId, conversationId);
        }
        throw error;
      }
    });
  }

  /**
   * Journal projection of a linked run. The run must exist for the principal in the link's
   * project and must have been admitted under the link's requestId (its canonical admission
   * identity); otherwise its terminal could settle another intention.
   */
  private async authoritativeRunState(principalId: string, link: Pick<RunLink, 'conversationId' | 'messageId' | 'projectId' | 'runId' | 'requestId'>): Promise<RunLink['state']> {
    return conversationStateFromRunStatus((await this.authoritativeRun(principalId,link)).status);
  }

  private async authoritativeRun(principalId: string, link: Pick<RunLink, 'conversationId' | 'messageId' | 'projectId' | 'runId' | 'requestId'>): Promise<AuthoritativeConversationRun> {
    if (!this.runAuthority) throw new WorkspaceError('run_authority_unavailable', 503);
    this.assertLinkAssociation(principalId, link.conversationId, link);
    const admission = this.admission(link.conversationId, link.requestId);
    if (!admission || admission.principalId !== principalId || admission.projectId !== link.projectId || admission.messageId !== link.messageId) throw new WorkspaceError('run_link_mismatch', 409);
    const run = await this.runAuthority(principalId, link.projectId, link.runId);
    if (!run) throw new WorkspaceError('run_not_found', 404);
    if (run.id !== link.runId || run.principalId !== principalId || run.projectId !== link.projectId || run.requestId !== admission.runRequestId
      || run.planId !== admission.planId || run.planDigest !== admission.planDigest) throw new WorkspaceError('run_link_mismatch', 409);
    return run;
  }

  /**
   * conversation -> message -> intent -> project association, checked inside the serialized
   * mutation. A conversation bound to a project only links runs of that project; an intent
   * admitted under this requestId must belong to the linked message of this conversation.
   */
  private assertLinkAssociation(principalId: string, conversationId: string, link: Pick<RunLink, 'projectId' | 'requestId'> & { messageId?: string }): { messageId: string; state: string } {
    const conversationProject = this.readConversationRow(principalId, conversationId).project_id;
    if (typeof conversationProject === 'string' && conversationProject !== link.projectId) throw new WorkspaceError('run_link_mismatch', 409);
    const temp = this.temporaryConversations.get(conversationId);
    const intent = temp
      ? temp.outbox.find((entry) => entry.requestId === link.requestId)
      : this.database.prepare('SELECT conversation_id AS conversationId, message_id AS messageId, state FROM conversation_outbox WHERE request_id=?')
        .get(link.requestId) as { conversationId: string; messageId: string; state: string } | undefined;
    if (!intent || intent.conversationId !== conversationId || (link.messageId !== undefined && intent.messageId !== link.messageId)) throw new WorkspaceError('run_link_mismatch', 409);
    return intent;
  }

  private static sameLinkIdentity(existing: Pick<RunLink, 'conversationId' | 'messageId' | 'projectId' | 'runId'>, link: Pick<RunLink, 'messageId' | 'projectId' | 'runId'>, conversationId: string): boolean {
    return existing.conversationId === conversationId && existing.messageId === link.messageId && existing.projectId === link.projectId && existing.runId === link.runId;
  }

  async linkRun(principalId: string, conversationId: string, input: unknown) {
    return this.serializeRun(conversationId, () => this.linkRunSerial(principalId, conversationId, input));
  }

  private async linkRunSerial(principalId: string, conversationId: string, input: unknown) {
    await this.ensureKey();
    this.readConversationRow(principalId, conversationId);
    let link: RunLink;
    try {
      const raw = (input ?? {}) as Record<string, unknown>;
      const state = raw.state === 'succeeded' ? 'completed' : (raw.state ?? 'queued');
      link = parseRunLink({ ...raw, state, conversationId });
    } catch (error) {
      throw toWorkspaceError(error);
    }
    const verifiedState = await this.authoritativeRunState(principalId, link);
    if (verifiedState) link = { ...link, state: verifiedState };
    return this.mutateRun(conversationId, () => {
      this.assertLinkAssociation(principalId, conversationId, link);
      const temp = this.temporaryConversations.get(conversationId);
      if (temp) {
        const msg = temp.messages.get(link.messageId);
        if (!msg) throw new WorkspaceError('message_not_found', 404);
        const existing = temp.runLinks.get(link.requestId);
        if (existing) {
          if (!ConversationStore.sameLinkIdentity(existing, link, conversationId)) {
            throw new WorkspaceError('run_link_conflict', 409);
          }
          const projected={...existing,state:link.state,lastSequence:Math.max(existing.lastSequence,link.lastSequence)};
          temp.runLinks.set(link.requestId,projected);
          if(TERMINAL_RUN_STATES.has(projected.state)){
            const intent=temp.outbox.find(entry=>entry.requestId===link.requestId&&entry.messageId===link.messageId)!;
            intent.state='consumed';intent.updatedAt=this.now().toISOString();
          }
          if(existing.state!==projected.state)this.appendEventRow(principalId,conversationId,{runId:link.runId,type:'run.state',payload:{requestId:link.requestId,state:projected.state,lastSequence:projected.lastSequence}});
          return projected;
        }
        this.assertLinkAssociation(principalId, conversationId, link);
        const normalizedLink: RunLink = {
          conversationId,
          messageId: link.messageId,
          requestId: link.requestId,
          runId: link.runId,
          projectId: link.projectId,
          ...(link.providerId !== undefined ? { providerId: link.providerId } : {}),
          ...(link.accountRef !== undefined ? { accountRef: link.accountRef } : {}),
          modelId: link.modelId,
          state: link.state,
          lastSequence: link.lastSequence,
        };
        temp.runLinks.set(link.requestId, normalizedLink);
        if (TERMINAL_RUN_STATES.has(normalizedLink.state)) {
          const intent = temp.outbox.find(entry => entry.requestId === link.requestId && entry.messageId === link.messageId)!;
          intent.state = 'consumed'; intent.updatedAt = this.now().toISOString();
        }
        this.appendEventRow(principalId, conversationId, {
          runId: link.runId, type: 'run.linked',
          payload: { messageId: link.messageId, requestId: link.requestId, runId: link.runId, modelId: link.modelId },
        });
        return normalizedLink;
      }
      const db = this.database;
      const message = db
        .prepare('SELECT id FROM messages WHERE id=? AND conversation_id=?')
        .get(link.messageId, conversationId) as { id: string } | undefined;
      if (!message) throw new WorkspaceError('message_not_found', 404);
      const existing = db.prepare('SELECT * FROM run_links WHERE request_id=?').get(link.requestId) as Record<
        string, unknown
      > | undefined;
      if (existing) {
        if (!ConversationStore.sameLinkIdentity({ conversationId: String(existing.conversation_id), messageId: String(existing.message_id), projectId: String(existing.project_id), runId: String(existing.run_id) }, link, conversationId)) {
          throw new WorkspaceError('run_link_conflict', 409);
        }
        const projected=this.linkView(existing);
        db.prepare('UPDATE run_links SET state=?, last_sequence=? WHERE request_id=?').run(link.state,Math.max(projected.lastSequence,link.lastSequence),link.requestId);
        if(TERMINAL_RUN_STATES.has(link.state))db.prepare("UPDATE conversation_outbox SET state='consumed',updated_at=? WHERE request_id=? AND conversation_id=? AND message_id=?").run(this.now().toISOString(),link.requestId,conversationId,link.messageId);
        if(projected.state!==link.state)this.appendEventRow(principalId,conversationId,{runId:link.runId,type:'run.state',payload:{requestId:link.requestId,state:link.state,lastSequence:Math.max(projected.lastSequence,link.lastSequence)}});
        return this.linkView(db.prepare('SELECT * FROM run_links WHERE request_id=?').get(link.requestId) as Record<string,unknown>);
      }
      this.assertLinkAssociation(principalId, conversationId, link);
      db.prepare(
        `INSERT INTO run_links(request_id, conversation_id, message_id, project_id, run_id,
          provider_id, account_ref, model_id, state, last_sequence)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        link.requestId, conversationId, link.messageId, link.projectId, link.runId,
        (link.providerId ?? null) as string | null, (link.accountRef ?? null) as string | null,
        link.modelId, link.state, link.lastSequence,
      );
      if (TERMINAL_RUN_STATES.has(link.state)) db.prepare("UPDATE conversation_outbox SET state='consumed', updated_at=? WHERE request_id=? AND conversation_id=? AND message_id=?")
        .run(this.now().toISOString(), link.requestId, conversationId, link.messageId);
      this.appendEventRow(principalId, conversationId, {
        runId: link.runId, type: 'run.linked',
        payload: { messageId: link.messageId, requestId: link.requestId, runId: link.runId, modelId: link.modelId },
      });
      const row = db.prepare('SELECT * FROM run_links WHERE request_id=?').get(link.requestId) as Record<string, unknown>;
      return this.linkView(row);
    });
  }

  private linkView(row: Record<string, unknown>) {
    return parseRunLink({
      conversationId: row.conversation_id, messageId: row.message_id, requestId: row.request_id,
      runId: row.run_id, projectId: row.project_id, providerId: row.provider_id ?? null,
      accountRef: row.account_ref ?? null, modelId: row.model_id, state: row.state,
      lastSequence: row.last_sequence,
    });
  }

  async updateRunState(principalId: string, conversationId: string, input: unknown) {
    return this.serializeRun(conversationId, () => this.updateRunStateSerial(principalId, conversationId, input));
  }

  private mutateRun<T>(conversationId: string, operation: () => T): T {
    return this.temporaryConversations.has(conversationId) ? operation() : this.txn(operation);
  }

  private async updateRunStateSerial(principalId: string, conversationId: string, input: unknown) {
    await this.ensureKey();
    this.readConversationRow(principalId, conversationId);
    const raw = input as Record<string, unknown>;
    if (!raw || typeof raw !== 'object' || typeof raw.requestId !== 'string') {
      throw new WorkspaceError('conversation_invalid');
    }
    const validStates = ['queued', 'streaming', 'awaiting_action', 'completed', 'interrupted', 'failed', 'cancelled', 'unknown', 'needs_attention'];
    if (typeof raw.state !== 'string' || !validStates.includes(raw.state)) throw new WorkspaceError('conversation_invalid');
    if (!Number.isSafeInteger(raw.lastSequence) || (raw.lastSequence as number) < 0) {
      throw new WorkspaceError('conversation_invalid');
    }
    const requestId = raw.requestId;
    let state = raw.state;
    const lastSequence = raw.lastSequence as number;
    {
      const known = this.temporaryConversations.get(conversationId)?.runLinks.get(requestId)
        ?? (() => {
          const row = this.database.prepare('SELECT * FROM run_links WHERE request_id=? AND conversation_id=?')
            .get(requestId, conversationId) as Record<string, unknown> | undefined;
          return row ? this.linkView(row) : undefined;
        })();
      if (!known) throw new WorkspaceError('conversation_not_found', 404);
      const verified = (await this.authoritativeRunState(principalId, known))!;
      // A client report is only an observation: a terminal it asserts must match the journal,
      // and a terminal recorded by the journal wins over a stale client projection.
      if (TERMINAL_RUN_STATES.has(verified)) state = verified;
      else if (TERMINAL_RUN_STATES.has(state)) throw new WorkspaceError('run_state_unverified', 409);
    }
    return this.mutateRun(conversationId, () => {
      this.readConversationRow(principalId, conversationId);
      const temp = this.temporaryConversations.get(conversationId);
      if (temp) {
        const prior = temp.runLinks.get(requestId);
        if (!prior) throw new WorkspaceError('conversation_not_found', 404);
        if (Number(lastSequence) < prior.lastSequence) throw new WorkspaceError('run_link_conflict', 409);
        const updated = parseRunLink({ ...prior, state: state, lastSequence: lastSequence });
        temp.runLinks.set(updated.requestId, updated);
        if (['completed', 'failed', 'cancelled'].includes(updated.state)) {
          // Only the intention associated with the linked message is settled.
          const intent = temp.outbox.find((entry) => entry.requestId === updated.requestId && entry.messageId === updated.messageId);
          if (intent) { intent.state = 'consumed'; intent.updatedAt = this.now().toISOString(); }
        }
        this.appendEventRow(principalId, conversationId, {
          runId: updated.runId, type: 'run.state',
          payload: { requestId: updated.requestId, state: updated.state, lastSequence: updated.lastSequence },
        });
        return updated;
      }
      const db = this.database;
      const row = db.prepare('SELECT * FROM run_links WHERE request_id=? AND conversation_id=?').get(
        requestId, conversationId,
      ) as Record<string, unknown> | undefined;
      if (!row) throw new WorkspaceError('conversation_not_found', 404);
      if (Number(lastSequence) < Number(row.last_sequence)) {
        throw new WorkspaceError('run_link_conflict', 409);
      }
      db.prepare('UPDATE run_links SET state=?, last_sequence=? WHERE request_id=?').run(
        state, lastSequence, requestId,
      );
      if (typeof state === 'string' && ['completed', 'failed', 'cancelled'].includes(state)) {
        db.prepare("UPDATE conversation_outbox SET state='consumed', updated_at=? WHERE request_id=? AND conversation_id=? AND message_id=?").run(
          this.now().toISOString(), requestId, conversationId, String(row.message_id),
        );
      }
      this.appendEventRow(principalId, conversationId, {
        runId: row.run_id as string, type: 'run.state',
        payload: { requestId: requestId, state: state, lastSequence: lastSequence },
      });
      return this.linkView(db.prepare('SELECT * FROM run_links WHERE request_id=?').get(requestId) as Record<string, unknown>);
    });
  }

  async listOutbox(principalId: string, conversationId: string) {
    this.readConversationRow(principalId, conversationId);
    const temp = this.temporaryConversations.get(conversationId);
    if (temp) return { intents: temp.outbox.filter((intent) => intent.state === 'queued').map((intent) => ({ ...intent })) };
    const rows = this.database
      .prepare("SELECT * FROM conversation_outbox WHERE conversation_id=? AND state='queued' ORDER BY created_at ASC")
      .all(conversationId) as Record<string, unknown>[];
    return {
      intents: rows.map((row) => ({
        requestId: row.request_id, conversationId, messageId: row.message_id,
        state: row.state, attempts: row.attempts, createdAt: row.created_at,
      })),
    };
  }

  // ------------------------------------------------------------------ eventos

  private appendEventRow(
    principalId: string, conversationId: string, input: { runId: string | null; type: string; payload: Record<string, unknown>; id?: string },
  ): ConversationEvent {
    const db = this.database;
    // Chave mestra já carregada em todos os caminhos chamadores via ensureKey prévia;
    // eventos exigem selo: recupera do cache sem I/O extra quando disponível.
    const master = this.masterKey;
    if (!master) throw new WorkspaceError('conversation_key_unavailable', 503);
    let event: ConversationEvent;
    try {
      // sequence real vem do MAX()+1 dentro da transação; valida-se a forma com 1.
      event = parseConversationEvent({
        id: input.id ?? randomUUID(), conversationId, runId: input.runId, sequence: 1,
        type: input.type, payload: input.payload, createdAt: this.now().toISOString(),
      });
    } catch (error) {
      throw toWorkspaceError(error);
    }
    const temp = this.temporaryConversations.get(conversationId);
    if (temp) {
      const sequence = temp.events.length + 1;
      const parsedEvent = parseConversationEvent({
        id: input.id ?? randomUUID(), conversationId, runId: input.runId, sequence,
        type: input.type, payload: input.payload, createdAt: this.now().toISOString(),
      });
      temp.events.push(parsedEvent);
      return parsedEvent;
    }
    const insert = this.txn(() => {
      const max = db.prepare('SELECT MAX(sequence) AS m FROM conversation_events WHERE conversation_id=?').get(
        conversationId,
      ) as { m: number | null };
      const sequence = (max.m ?? 0) + 1;
      const sealed = this.seal(master, principalId, conversationId, 'event', Buffer.from(canonicalJson(event.payload), 'utf8'));
      const createdAt = this.now().toISOString();
      const applied = db.prepare(
        `INSERT INTO conversation_events(id, conversation_id, run_id, sequence, type,
          sealed_nonce, sealed_ciphertext, sealed_tag, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      ).run(event.id, conversationId, event.runId, sequence, event.type, sealed.nonce, sealed.ciphertext, sealed.tag, createdAt);
      if (applied.changes === 0) {
        const prior = db.prepare('SELECT * FROM conversation_events WHERE id=?').get(event.id) as Record<string, unknown>;
        return this.hydrateEvent(principalId, conversationId, prior, master);
      }
      return { ...event, sequence, createdAt };
    });
    return insert;
  }

  private hydrateEvent(principalId: string, conversationId: string, row: Record<string, unknown>, master: Buffer): ConversationEvent {
    const payload = JSON.parse(
      this.openSealed(master, principalId, conversationId, 'event', {
        nonce: row.sealed_nonce as string, ciphertext: row.sealed_ciphertext as string, tag: row.sealed_tag as string,
      }).toString('utf8'),
    ) as Record<string, unknown>;
    return parseConversationEvent({
      id: row.id, conversationId, runId: row.run_id ?? null, sequence: row.sequence,
      type: row.type, payload, createdAt: row.created_at,
    });
  }

  async appendEvent(principalId: string, conversationId: string, input: unknown, revalidate?: () => Promise<void>) {
    await this.ensureKey();
    await revalidate?.();
    this.readConversationRow(principalId, conversationId);
    const raw = input as Record<string, unknown>;
    if (!raw || typeof raw !== 'object') throw new WorkspaceError('conversation_invalid');
    return this.serial(`conv:${conversationId}`, () =>
      this.appendEventRow(principalId, conversationId, {
        runId: raw.runId === undefined || raw.runId === null ? null : String(raw.runId),
        type: String(raw.type ?? ''),
        payload: (raw.payload ?? {}) as Record<string, unknown>,
        id: typeof raw.id === 'string' ? raw.id : undefined,
      }),
    );
  }

  async listEvents(principalId: string, conversationId: string, query: { after?: unknown; limit?: unknown }) {
    const master = await this.ensureKey();
    let after = 0;
    if (query.after !== undefined && query.after !== null && query.after !== '') {
      if (typeof query.after !== 'string' || !/^(?:0|[1-9][0-9]{0,8})$/.test(query.after)) {
        throw new WorkspaceError('conversation_invalid');
      }
      after = Number(query.after);
    }
    let limit = 50;
    if (query.limit !== undefined && query.limit !== null) {
      if (typeof query.limit !== 'number' || !Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 200) {
        throw new WorkspaceError('conversation_invalid');
      }
      limit = query.limit as number;
    }
    this.readConversationRow(principalId, conversationId);
    const temp = this.temporaryConversations.get(conversationId);
    if (temp) {
      const filtered = temp.events.filter((event) => event.sequence > after);
      const page = filtered.slice(0, limit);
      return { events: page, nextCursor: filtered.length > limit ? String(page.at(-1)!.sequence) : null };
    }
    const rows = this.database
      .prepare('SELECT * FROM conversation_events WHERE conversation_id=? AND sequence > ? ORDER BY sequence ASC LIMIT ?')
      .all(conversationId, after, limit + 1) as Record<string, unknown>[];
    const page = rows.slice(0, limit);
    return {
      events: page.map((row) => this.hydrateEvent(principalId, conversationId, row, master)),
      nextCursor: rows.length > limit ? String(page.at(-1)!.sequence as number) : null,
    };
  }

  // ------------------------------------------------------------------ import

  async importSessions(principalId: string, input: unknown, revalidate?: () => Promise<void>) {
    const master = await this.ensureKey();
    await revalidate?.();
    void master;
    let parsed;
    try {
      parsed = parseImportSessions(input);
    } catch (error) {
      throw toWorkspaceError(error);
    }
    const digest = createHash('sha256').update(canonicalJson({principalId,payload:canonicalImportPayload(parsed)})).digest('hex');
    const db = this.database;
    const prior = db.prepare('SELECT conversation_ids FROM conversation_imports WHERE origin_digest=?').get(digest) as {
      conversation_ids: string;
    } | undefined;
    if (prior) {
      return { imported: false, conversationIds: JSON.parse(prior.conversation_ids) as string[], originDigest: digest };
    }
    // Preserve idempotency for pre-fix imports only after checking every returned owner.
    const legacyDigest=createHash('sha256').update(canonicalImportPayload(parsed)).digest('hex');
    const legacy=db.prepare('SELECT conversation_ids FROM conversation_imports WHERE origin_digest=?').get(legacyDigest) as {conversation_ids:string}|undefined;
    if(legacy){const ids=JSON.parse(legacy.conversation_ids) as string[];
      if(ids.length&&ids.every(id=>(db.prepare('SELECT principal_id FROM conversations WHERE id=?').get(id) as {principal_id:string}|undefined)?.principal_id===principalId))return {imported:false,conversationIds:ids,originDigest:digest};
    }
    const conversationIds: string[] = [];
    const createdAt = this.now().toISOString();
    try {
      this.txn(() => {
      for (const session of parsed.sessions) {
        const id = randomUUID();
        const title = (session.title || 'Conversa importada').slice(0, 160) || 'Conversa importada';
        db.prepare(
          `INSERT INTO conversations(id, principal_id, workspace_id, project_id, title, created_at, updated_at,
            revision, archived_at, active_branch_id, origin, origin_digest)
           VALUES(?, ?, ?, NULL, ?, ?, ?, 1, NULL, 'main', ?, ?)`,
        ).run(id, principalId, workspaceIdFor(principalId), title, createdAt, createdAt, parsed.origin, `import:${session.id}:${digest.slice(0, 16)}`);
        let parentId: string | null = null;
        session.messages.forEach((message, index) => {
          const messageId = randomUUID();
          // Ordem de leitura é rowid (inserção): nenhum carimbo fabricado.
          void index;
          const messageAt = createdAt;
          const sealed = this.seal(
            this.masterKey!, principalId, id, 'message',
            Buffer.from(canonicalJson({ bodyDigest: `import:${digest}:${index}`, role: message.role }), 'utf8'),
          );
          db.prepare(
            `INSERT INTO messages(id, conversation_id, parent_id, branch_id, role, client_message_id,
              created_at, revision, sealed_nonce, sealed_ciphertext, sealed_tag)
             VALUES(?, ?, ?, 'main', ?, ?, ?, 1, ?, ?, ?)`,
          ).run(
            messageId, id, parentId, message.role, `import:${session.id}:${index}`, messageAt,
            sealed.nonce, sealed.ciphertext, sealed.tag,
          );
          const partId = randomUUID();
          const partSealed = this.seal(
            this.masterKey!, principalId, id, 'part',
            Buffer.from(canonicalJson({ type: 'text', text: message.content, artifactRef: null }), 'utf8'),
          );
          db.prepare(
            `INSERT INTO message_parts(id, message_id, type, artifact_ref, call_id, name,
              sealed_nonce, sealed_ciphertext, sealed_tag) VALUES(?, ?, 'text', NULL, NULL, NULL, ?, ?, ?)`,
          ).run(partId, messageId, partSealed.nonce, partSealed.ciphertext, partSealed.tag);
          parentId = messageId;
        });
        conversationIds.push(id);
      }
      db.prepare('INSERT INTO conversation_imports(origin_digest, conversation_ids, created_at) VALUES(?, ?, ?)').run(
        digest, JSON.stringify(conversationIds), createdAt,
      );
      });
    } catch (error) {
      // Corrida entre duas importações idênticas: a perdedora relê o registro vencedor.
      const raced = db.prepare('SELECT conversation_ids FROM conversation_imports WHERE origin_digest=?').get(digest) as {
        conversation_ids: string;
      } | undefined;
      if (raced) {
        return { imported: false, conversationIds: JSON.parse(raced.conversation_ids) as string[], originDigest: digest };
      }
      throw error;
    }
    return { imported: true, conversationIds, originDigest: digest };
  }
}

// ---------------------------------------------------------------- gate externa
// O gate `app.use("*")` de app.ts resolve método/query antes dos handlers;
// estas funções espelham workspaceMethod/workspaceUsageQuery sem tocá-las.

const CONVERSATION_ID = '[A-Za-z0-9][A-Za-z0-9_-]{0,99}';
const CONVERSATION_UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CONVERSATION_READ = new RegExp(
  `^/v1/workspace/conversations(?:/(${CONVERSATION_UUID})(?:/(messages|events|outbox|export|runs|budget))?|/search)?$`,
);
const CONVERSATION_WRITE = new RegExp(
  `^/v1/workspace/conversations/(?:create|import|(${CONVERSATION_UUID})/(update|delete|messages|runs|events|budget))$`,
);

export function conversationMethod(path: string, method: string): 'GET' | 'POST' | undefined {
  if (method === 'GET') return CONVERSATION_READ.test(path) ? 'GET' : undefined;
  if (method === 'POST') return CONVERSATION_WRITE.test(path) ? 'POST' : undefined;
  return undefined;
}

export function conversationQueryAllowed(url: URL): boolean {
  if (url.pathname === '/v1/workspace/conversations/search') {
    return [...url.searchParams.keys()].every((key) => ['q', 'limit'].includes(key))
      && url.searchParams.getAll('q').length === 1
      && (url.searchParams.getAll('limit').length === 0 || url.searchParams.getAll('limit').length === 1)
      && (url.searchParams.get('q') ?? '').trim().length >= 2;
  }
  if (!CONVERSATION_READ.test(url.pathname)) return false;
  const keys = [...url.searchParams.keys()];
  if (!keys.every((key) => ['after', 'limit', 'query', 'includeArchived'].includes(key))) return false;
  for (const key of ['after', 'limit', 'query', 'includeArchived']) {
    if (url.searchParams.getAll(key).length > 1) return false;
  }
  return true;
}

// ---------------------------------------------------------------- montagem HTTP

export interface ConversationRouteDeps {
  budgets?: import('./governance-service.ts').WorkspacePolicyService;
  secrets: SecretStore;
  principal: (header: string | undefined) => Promise<string | undefined>;
  ready: Promise<void>;
  root?: string;
  projectGrant?: (header: string | undefined) => Promise<LocalProjectGrant | undefined>;
  retentionMode?: (header: string | undefined) => Promise<'standard' | 'ephemeral' | undefined>;
  /** Workspace journal lookup; when present, run links/terminals are verified by the core. */
  runAuthority?: RunAuthority;
  runRequestAuthority?: RunRequestAuthority;
}

/** Reads a run owned by `principalId` in `projectId`; null when absent or foreign. */
export type AuthoritativeConversationRun = { id: string; principalId: string; status: RunStatus; requestId: string; projectId: string; planId: string; planDigest: string; stepStates?: StepState[]; receipts?: ExecutionReceipt[] };
export type RunAuthority = (principalId: string, projectId: string, runId: string) => Promise<AuthoritativeConversationRun | null>;
export type RunRequestAuthority = (principalId: string, projectId: string, requestId: string) => Promise<AuthoritativeConversationRun | null>;

const TERMINAL_RUN_STATES = new Set<string>(['completed', 'failed', 'cancelled']);

export function conversationStateFromRunStatus(status: RunStatus): RunLink['state'] {
  switch (status) {
    case 'running': return 'streaming';
    case 'awaiting_approval': return 'awaiting_action';
    case 'succeeded': return 'completed';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    case 'needs_attention': return 'needs_attention';
    default: return 'queued';
  }
}

export function resolveConversationRoot(): string {
  if (process.env.UPTOKEY_CONVERSATIONS_DIR !== undefined) {
    const override = process.env.UPTOKEY_CONVERSATIONS_DIR;
    if (!override.trim()) throw new WorkspaceError('conversation_invalid', 400);
    return override;
  }
  return join(dataDir(), 'conversations');
}

export function mountConversationRoutes(app: Hono, deps: ConversationRouteDeps): { store: ConversationStore; close: () => void } {
  const store = new ConversationStore(deps.secrets, deps.root ?? resolveConversationRoot(), undefined, {
    onTemporaryConversationEnded: (principalId, conversationId) => {
      // Expiry is a session end: do not retain the ephemeral budget beyond it.
      void deps.budgets?.forgetTemporaryConversationBudget(principalId, conversationId).catch(() => undefined);
    },
  });
  store.setRunAuthority(deps.runAuthority, deps.runRequestAuthority);
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  app.all('/v1/workspace/conversations*', async (c) => {
    try {
      await deps.ready;
      const owner = await deps.principal(c.req.header('authorization'));
      if (!owner) return c.json({ error: { type: 'unauthorized' } }, 401);
      const projects = deps.projectGrant ? await deps.projectGrant(c.req.header('authorization')) : '*';
      if (projects === undefined) return c.json({error:{type:'unauthorized'}},401);
      const requireProject = (id: unknown) => {if(!isProjectGranted(projects,id))throw new WorkspaceError('resource_not_granted',403);};
      const url = new URL(c.req.url);
      const path = url.pathname;
      let input: unknown;
      if (c.req.method === 'POST') {
        const isImport = path === '/v1/workspace/conversations/import';
        const parsed = await readBoundedJson(c.req.raw, isImport ? IMPORT_BODY_LIMIT_BYTES : BODY_LIMIT_BYTES);
        if (!parsed.ok) {
          return c.json({ error: { type: parsed.reason === 'too_large' ? 'payload_too_large' : 'invalid_request' } }, parsed.reason === 'too_large' ? 400 : 400);
        }
        input = parsed.value;
      }
      const readRetention = async () => {
        if (!deps.retentionMode) return 'standard' as const;
        const mode = await deps.retentionMode(c.req.header('authorization'));
        if (mode === undefined) throw new WorkspaceError('unauthorized',403);
        return mode;
      };
      const ephemeral = await readRetention() === 'ephemeral';
      const requireRetention = async (temporary: boolean, projectId?: string | null) => {
        // Linking/revoking context can change the data owner while storage awaits.
        // Re-read ownership as well as the project grant before returning or writing.
        if (await deps.principal(c.req.header('authorization')) !== owner) throw new WorkspaceError('conversation_authority_changed',403);
        if (deps.projectGrant && projectId !== undefined) {
          const currentProjects = await deps.projectGrant(c.req.header('authorization'));
          if (currentProjects === undefined) throw new WorkspaceError('unauthorized',403);
          if (!isProjectGranted(currentProjects, projectId)) throw new WorkspaceError('resource_not_granted',403);
        }
        // Read again after storage/key awaits. A pending write may not use an older,
        // less restrictive policy; a request admitted ephemeral cannot relax either.
        if ((await readRetention() === 'ephemeral' || ephemeral) && !temporary) {
          throw new WorkspaceError('ephemeral_mode_persistence_blocked',403);
        }
      };
      if (c.req.method === 'GET' && path === '/v1/workspace/conversations/search') {
        await requireRetention(false);
        const result = await store.searchMessages(owner, {
            query: url.searchParams.get('q'), limit: coerceLimit(url.searchParams.get('limit')),
          }, projects);
        await requireRetention(false);
        return c.json(result);
      }
      if (c.req.method === 'GET' && path === '/v1/workspace/conversations') {
        // Temporary conversations intentionally never enter the saved-history index.
        if (ephemeral) return c.json({conversations:[],nextCursor:null});
        const result = await store.listConversations(owner, {
            after: url.searchParams.get('after'), limit: coerceLimit(url.searchParams.get('limit')),
            query: url.searchParams.get('query'), includeArchived: url.searchParams.get('includeArchived') === 'true',
          }, projects);
        await requireRetention(false);
        return c.json(result);
      }
      if (c.req.method === 'POST' && path === '/v1/workspace/conversations/create') {
        const body = input as Record<string, unknown>;
        requireProject(body?.projectId);
        const storagePolicy = body?.storagePolicy ?? (ephemeral ? 'temporary' : 'local');
        const revalidate = () => requireRetention(storagePolicy === 'temporary' && body?.cloudSyncOptIn !== true, (body?.projectId ?? null) as string | null);
        return c.json(await store.createConversation(owner, { title: body?.title, projectId: body?.projectId, storagePolicy, processingPolicy: body?.processingPolicy, cloudSyncOptIn: body?.cloudSyncOptIn }, revalidate), 201);
      }
      if (c.req.method === 'POST' && path === '/v1/workspace/conversations/import') {
        requireProject(null); // Current import contract creates unbound conversations.
        return c.json(await store.importSessions(owner, input, () => requireRetention(false,null)), 201);
      }
      const match = new RegExp(`^/v1/workspace/conversations/(${uuid})((?:/[a-z]+)?)$`).exec(path);
      if (!match) return c.json({ error: { type: 'route_not_found' } }, 404);
      const conversationId = match[1]!;
      const suffix = match[2] ?? '';
      const conversation = await store.getConversation(owner,conversationId);
      requireProject(conversation.projectId);
      const revalidate = () => requireRetention(conversation.storagePolicy === 'temporary',conversation.projectId);
      await revalidate();
      if (suffix === '/budget' && (c.req.method === 'GET' || c.req.method === 'POST')) {
        if (!deps.budgets) throw new WorkspaceError('budget_unavailable',503);
        const scope = { id: conversation.id, temporary: conversation.storagePolicy === 'temporary' };
        if (c.req.method === 'GET') {
          const result = await deps.budgets.getConversationBudget(owner, scope);
          await revalidate();
          return c.json(result);
        }
        const body = input as Record<string, unknown>;
        if (!body || Array.isArray(body) || Object.keys(body).some(k => !['limitMicros','expectedRevision'].includes(k)) ||
          !Object.hasOwn(body,'limitMicros') || !Object.hasOwn(body,'expectedRevision')) throw new WorkspaceError('budget_invalid',400);
        return c.json(await deps.budgets.setConversationBudget(owner,scope,body.limitMicros as number|null,body.expectedRevision as number,revalidate));
      }
      if (c.req.method === 'GET' && suffix === '') {
        const result = await store.getConversation(owner, conversationId);
        await revalidate();
        return c.json(result);
      }
      if (c.req.method === 'POST' && suffix === '/update') {
        return c.json(await store.updateConversation(owner, conversationId, input as never, revalidate));
      }
      if (c.req.method === 'POST' && suffix === '/delete') {
        const body = input as Record<string, unknown>;
        const result = await store.deleteConversation(owner, conversationId, body?.expectedRevision, revalidate);
        if (conversation.storagePolicy === 'temporary') await deps.budgets?.forgetTemporaryConversationBudget(owner,conversationId);
        return c.json(result);
      }
      if (c.req.method === 'GET' && suffix === '/export') {
        await requireRetention(false);
        const result = await store.exportConversation(owner, conversationId);
        await requireRetention(false, conversation.projectId);
        return c.json(result);
      }
      if (c.req.method === 'GET' && suffix === '/messages') {
        const result = await store.listMessages(owner, conversationId, {
            after: url.searchParams.get('after'), limit: coerceLimit(url.searchParams.get('limit')),
          });
        await revalidate();
        return c.json(result);
      }
      if (c.req.method === 'POST' && suffix === '/messages') {
        return c.json(await store.appendMessage(owner, conversationId, input, revalidate), 201);
      }
      if (c.req.method === 'POST' && suffix === '/runs') {
        await requireRetention(false);
        const body = input as Record<string, unknown>;
        if (body?.op === 'link') return c.json(await store.linkRun(owner, conversationId, body.link), 201);
        if (body?.op === 'state') return c.json(await store.updateRunState(owner, conversationId, body.state));
        return c.json({ error: { type: 'invalid_request' } }, 400);
      }
      if (c.req.method === 'GET' && suffix === '/runs') {
        const result = await store.continuityRuns(owner, conversationId);
        await revalidate();
        return c.json(result);
      }
      if (c.req.method === 'GET' && suffix === '/events') {
        const result = await store.listEvents(owner, conversationId, {
            after: url.searchParams.get('after'), limit: coerceLimit(url.searchParams.get('limit')),
          });
        await revalidate();
        return c.json(result);
      }
      if (c.req.method === 'POST' && suffix === '/events') {
        return c.json(await store.appendEvent(owner, conversationId, input, revalidate), 201);
      }
      if (c.req.method === 'GET' && suffix === '/outbox') {
        const result = await store.listOutbox(owner, conversationId);
        await revalidate();
        return c.json(result);
      }
      return c.json({ error: { type: 'route_not_found' } }, 404);
    } catch (error) {
      if (error instanceof Error && ['budget_revision_conflict','budget_invalid','budget_amount_invalid'].includes(error.message)) {
        return c.json({error:{type:error.message}},error.message==='budget_revision_conflict'?409:400);
      }
      if (error instanceof WorkspaceError) {
        return c.json(
          { error: { type: error.code, ...(error.details !== undefined ? { details: error.details } : {}) } },
          error.status,
        );
      }
      if (error instanceof Error && error.message === 'conversation_key_unavailable') {
        return c.json({ error: { type: 'conversation_key_unavailable' } }, 503);
      }
      return c.json({ error: { type: 'workspace_unavailable' } }, 503);
    }
  });
  return { store, close: () => store.close() };
}

function coerceLimit(raw: string | null): number | null {
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : NaN;
}
