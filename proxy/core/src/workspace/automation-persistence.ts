/**
 * E2-13 — persistência durável do AutomationService (SQLite local).
 *
 * Correção da revisão: os stores do executor eram in-memory; a spec exige
 * "persistência durável precede ativar agenda" e recuperação após reinício
 * real. Este módulo grava o estado completo em `automations.db` (WAL) dentro
 * de uma transação a cada mutação e hidrata na construção. Os dados são
 * metadados de automação (conversas de tarefa, presets, ocorrências, outbox
 * sintética) — nenhum segredo/transcrição de chat principal é persistido aqui.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dataDir } from "../paths.ts";
import { WorkspaceError } from "./runtime.ts";

const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS automation_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS automation_conversations(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS automation_messages(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS automation_tasks(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS automation_receipts(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS automation_presets(key TEXT PRIMARY KEY, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS automation_schedules(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS automation_occurrences(key TEXT PRIMARY KEY, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS automation_grants(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS automation_chains(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS automation_outbox(fingerprint TEXT PRIMARY KEY, payload TEXT NOT NULL, ordinal INTEGER NOT NULL);
`;

export type AutomationPersistedState = {
  conversations: Array<[string, unknown]>;
  messages: Array<[string, unknown]>;
  tasks: Array<[string, unknown]>;
  receipts: Array<[string, unknown]>;
  presets: Array<[string, unknown]>;
  schedules: Array<[string, unknown]>;
  occurrences: Array<[string, unknown]>;
  grants?: Array<[string, unknown]>;
  chains?: Array<[string, unknown]>;
  outbox: Array<[string, unknown]>;
  outboxOrder: string[];
};

export function resolveAutomationRoot(): string {
  if (process.env.UPTOKEY_AUTOMATIONS_DIR !== undefined) {
    const override = process.env.UPTOKEY_AUTOMATIONS_DIR;
    if (!override.trim()) throw new WorkspaceError("automation_invalid");
    return override;
  }
  return join(dataDir(), "automations");
}

export class AutomationPersistence {
  private db: DatabaseSync | null = null;
  // An explicit field supports --experimental-strip-types without changing constructor semantics.
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  open(): void {
    if (this.db) return;
    mkdirSync(this.root, { recursive: true });
    const db = new DatabaseSync(join(this.root, "automations.db"));
    db.exec("PRAGMA journal_mode=WAL;");
    db.exec("PRAGMA busy_timeout=5000;");
    db.exec(SCHEMA_SQL);
    const applied = db.prepare("SELECT value FROM automation_meta WHERE key='schema_version'").get() as
      | { value: string }
      | undefined;
    if (!applied) {
      db.prepare("INSERT INTO automation_meta(key, value) VALUES('schema_version', ?)").run(String(SCHEMA_VERSION));
    } else if (Number(applied.value) !== SCHEMA_VERSION) {
      // Recusa estado de versão desconhecida em vez de aceitar irrestrito.
      throw new WorkspaceError("automation_persistence_version_unsupported", 503);
    }
    this.db = db;
  }

  close(): void {
    try {
      this.db?.close();
    } finally {
      this.db = null;
    }
  }

  /** Gravação atômica do estado completo (dados pequenos; idempotente). */
  save(state: AutomationPersistedState): void {
    this.open();
    const db = this.db!;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const table of ["automation_conversations", "automation_messages", "automation_tasks", "automation_receipts", "automation_presets", "automation_schedules", "automation_occurrences", "automation_outbox", "automation_grants", "automation_chains"]) {
        db.prepare(`DELETE FROM ${table}`).run();
      }
      const putWith = (table: string, keyColumn: string, key: string, value: unknown) =>
        db.prepare(`INSERT INTO ${table}(${keyColumn}, payload) VALUES(?, ?)`).run(key, JSON.stringify(value));
      for (const [id, payload] of state.conversations) putWith("automation_conversations", "id", id, payload);
      for (const [id, payload] of state.messages) putWith("automation_messages", "id", id, payload);
      for (const [id, payload] of state.tasks) putWith("automation_tasks", "id", id, payload);
      for (const [id, payload] of state.receipts) putWith("automation_receipts", "id", id, payload);
      for (const [key, payload] of state.presets) putWith("automation_presets", "key", key, payload);
      for (const [id, payload] of state.schedules) putWith("automation_schedules", "id", id, payload);
      for (const [key, payload] of state.occurrences) putWith("automation_occurrences", "key", key, payload);
      for (const [id, payload] of state.grants ?? []) putWith("automation_grants", "id", id, payload);
      for (const [id, payload] of state.chains ?? []) putWith("automation_chains", "id", id, payload);
      const putOutbox = db.prepare("INSERT INTO automation_outbox(fingerprint, payload, ordinal) VALUES(?, ?, ?)");
      state.outbox.forEach(([fingerprint, payload], ordinal) => putOutbox.run(fingerprint, JSON.stringify(payload), ordinal));
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* mantém o erro original */
      }
      throw error;
    }
  }

  load(): AutomationPersistedState | undefined {
    this.open();
    const db = this.db!;
    const rows = <T>(table: string, keyColumn: string): Array<[string, T]> =>
      (db.prepare(`SELECT ${keyColumn} AS k, payload FROM ${table}`).all() as Array<{ k: string; payload: string }>).map(
        (row) => [row.k, JSON.parse(row.payload) as T],
      );
    const conversations = rows<unknown>("automation_conversations", "id");
    const messages = rows<unknown>("automation_messages", "id");
    const tasks = rows<unknown>("automation_tasks", "id");
    const receipts = rows<unknown>("automation_receipts", "id");
    const presets = rows<unknown>("automation_presets", "key");
    const schedules = rows<unknown>("automation_schedules", "id");
    const occurrences = rows<unknown>("automation_occurrences", "key");
    const grants = rows<unknown>("automation_grants", "id");
    const chains = rows<unknown>("automation_chains", "id");
    if (
      !conversations.length && !messages.length && !tasks.length && !receipts.length &&
      !presets.length && !schedules.length && !occurrences.length && !grants.length && !chains.length
    ) {
      const outboxRows = db.prepare("SELECT fingerprint, payload, ordinal FROM automation_outbox ORDER BY ordinal").all() as Array<{
        fingerprint: string;
        payload: string;
        ordinal: number;
      }>;
      if (!outboxRows.length) return undefined;
    }
    const outboxRows = db.prepare("SELECT fingerprint, payload, ordinal FROM automation_outbox ORDER BY ordinal").all() as Array<{
      fingerprint: string;
      payload: string;
      ordinal: number;
    }>;
    return {
      conversations,
      messages,
      tasks,
      receipts,
      presets,
      schedules,
      occurrences,
      grants,
      chains,
      outbox: outboxRows.map((row) => [row.fingerprint, JSON.parse(row.payload) as unknown]),
      outboxOrder: outboxRows.map((row) => row.fingerprint),
    };
  }
}
