import { mkdir, lstat, open } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readJson, writeJsonAtomic } from "../atomic-json.ts";
import { assertQuimeraDataPath } from "../paths.ts";
import { emptyEgressJournal, type EgressJournal, type EgressReceiptRecord } from "./types.ts";

/** The egress owner keeps configuration in its original JSON. Historical JSON
 * receipts stay there, unchanged. Only NEW receipts enter the append-only SQLite
 * table; no profile migration, deletion, second executor, or secret storage. */
export class EgressPersistence {
  private readonly path: string;
  private db: DatabaseSync | undefined;
  private legacy: EgressReceiptRecord[] = [];
  private receipts: EgressReceiptRecord[] = [];
  private confirmed = 0;
  private receiptOffset = 0;
  private metadata = "";
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(path: string) { this.path = assertQuimeraDataPath(path); }

  async load(): Promise<EgressJournal> {
    if (this.db || this.closed) throw new Error("egress_persistence_state_invalid");
    const journal = await readJson(this.path, emptyEgressJournal());
    if (!journal || !Array.isArray(journal.receipts)) throw new Error("egress_journal_invalid");
    this.legacy = journal.receipts.map(freezeReceipt);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const databasePath = assertQuimeraDataPath(`${this.path}.receipts.db`);
    for (const candidate of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`, `${databasePath}-journal`]) {
      try {
        const stat = await lstat(candidate);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("egress_database_path_invalid");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    try { const file = await open(databasePath, "wx", 0o600); await file.close(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const db = new DatabaseSync(databasePath);
    try {
      const version = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
      const application = Number(db.prepare("PRAGMA application_id").get()!.application_id);
      const legacyDigest = createHash("sha256").update(JSON.stringify(this.legacy)).digest("hex");
      if (version !== 0 && version !== 1) throw new Error("egress_database_version_unsupported");
      if (version === 0 && (application !== 0 || db.prepare("SELECT name FROM sqlite_master").all().length)) throw new Error("egress_database_invalid");
      if (version === 1 && application !== 1431323986) throw new Error("egress_database_invalid");
      db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;");
      if (version === 0) {
        db.exec("BEGIN IMMEDIATE; CREATE TABLE egress_receipts(sequence INTEGER PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE egress_origin(legacy_digest TEXT NOT NULL); PRAGMA application_id=1431323986; PRAGMA user_version=1;");
        db.prepare("INSERT INTO egress_origin VALUES(?)").run(legacyDigest);
        db.exec("COMMIT");
      }
      const origins = db.prepare("SELECT legacy_digest FROM egress_origin").all();
      if (origins.length !== 1 || origins[0]!.legacy_digest !== legacyDigest) throw new Error("egress_history_origin_mismatch");
      const storedCount = Number(db.prepare("SELECT COUNT(*) AS n FROM egress_receipts").get()!.n);
      const stored = db.prepare("SELECT payload FROM egress_receipts ORDER BY sequence DESC LIMIT 256").all()
        .reverse().map(row => freezeReceipt(JSON.parse(String(row.payload))));
      // Keep a bounded working tail, not a second in-memory copy of all durable
      // audit history. Older receipts remain addressable through receiptPage.
      this.receipts = [...this.legacy.slice(-256), ...stored].slice(-256);
      this.confirmed = this.legacy.length + storedCount;
      this.receiptOffset = this.confirmed - this.receipts.length;
      const { receipts: ignored, ...metadata } = journal;
      this.metadata = JSON.stringify(metadata);
      this.db = db;
      return { ...metadata, receipts: this.receipts };
    } catch (error) { db.close(); throw error; }
  }

  save(journal: EgressJournal): Promise<void> {
    if (!this.db || this.closed || journal.receipts !== this.receipts) return Promise.reject(new Error("egress_persistence_state_invalid"));
    const target = this.receiptOffset + journal.receipts.length;
    const capturedStart = this.confirmed;
    let captured: EgressReceiptRecord[];
    try { captured = journal.receipts.slice(capturedStart - this.receiptOffset).map(freezeReceipt); }
    catch (error) { return Promise.reject(error); }
    const { receipts: ignored, ...metadata } = journal;
    const encoded = JSON.stringify(metadata);
    const work = this.queue.then(async () => {
      if (target < this.confirmed) throw new Error("egress_receipt_history_rewrite_forbidden");
      // Commit pending receipts before changing policy. A receipt failure must
      // not install configuration on disk while its owner reports failure.
      if (target !== this.confirmed) {
      const db = this.db!;
      db.exec("BEGIN IMMEDIATE");
      try {
        const insert = db.prepare("INSERT INTO egress_receipts(payload) VALUES(?)");
        for (let i = this.confirmed; i < target; i++) insert.run(JSON.stringify(captured[i - capturedStart]!));
        db.exec("COMMIT");
        this.confirmed = target;
        const discard = Math.max(0, this.confirmed - this.receiptOffset - 256);
        this.receipts.splice(0, discard);
        this.receiptOffset += discard;
      } catch (error) { try { db.exec("ROLLBACK"); } catch { /* keep original failure */ } throw error; }
      }
      // Configuration keeps its canonical JSON format and all legacy receipts.
      // A failed JSON write can leave extra audit receipts, never new policy.
      if (encoded !== this.metadata) {
        await writeJsonAtomic(this.path, { ...JSON.parse(encoded), receipts: this.legacy });
        this.metadata = encoded;
      }
    });
    this.queue = work.catch(() => undefined);
    return work;
  }

  /** Read committed audit history without expanding the live journal. No deletion
   * or retention policy is implied by the 256-item in-memory working tail. */
  receiptPage(offset = 0, limit = 100): { items: EgressReceiptRecord[]; nextOffset: number | null; total: number } {
    if (!this.db || this.closed) throw new Error("egress_persistence_state_invalid");
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new Error("egress_receipt_page_invalid");
    const items = this.legacy.slice(offset, Math.min(this.legacy.length, offset + limit));
    if (items.length < limit && offset < this.confirmed) {
      const rows = this.db.prepare("SELECT payload FROM egress_receipts ORDER BY sequence LIMIT ? OFFSET ?")
        .all(limit - items.length, Math.max(0, offset - this.legacy.length));
      items.push(...rows.map(row => freezeReceipt(JSON.parse(String(row.payload)))));
    }
    return { items, nextOffset: offset + items.length < this.confirmed ? offset + items.length : null, total: this.confirmed };
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.queue;
    this.db?.close(); this.db = undefined;
  }
}

function freezeReceipt(value: EgressReceiptRecord): EgressReceiptRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof value.attemptId !== "string" || !value.attemptId || value.attemptId.length > 256
    || typeof value.finalHost !== "string" || !value.finalHost || value.finalHost.length > 512 || value.finalHost.includes("@")
    || typeof value.transportKind !== "string" || value.transportKind.length > 64
    || typeof value.reason !== "string" || value.reason.length > 256 || typeof value.usedDirect !== "boolean"
    || ![value.poolId, value.memberId].every(item => item === null || (typeof item === "string" && item.length <= 256))
    || !(value.poolRevision === null || (Number.isSafeInteger(value.poolRevision) && value.poolRevision >= 0))
    || Object.keys(value).some(key => !["attemptId", "poolId", "poolRevision", "memberId", "finalHost", "transportKind", "usedDirect", "reason"].includes(key))) throw new Error("egress_receipt_invalid");
  return Object.freeze({ ...value });
}
