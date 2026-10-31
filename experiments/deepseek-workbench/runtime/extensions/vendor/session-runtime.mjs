import { errorChain } from "@deepseek-ai/dsh-llm";
import { SessionAlreadyExistsError, SessionAlreadyOwnedError, SessionHandleClosedError, SessionPersistenceNotFoundError, SessionPersistenceRevision, SessionReadOnlyError, assertContiguous, materializeAppendBatch } from "@deepseek-ai/dsh-session-persistence";
//#region upstream/packages/session/session-persistence-jsonl/src/storage.ts
/** Maximum intentional wait before a routed live session batch starts writing. */
const LIVE_WRITE_BATCH_MAX_DELAY_MS = 200;
/**
* The JSONL session handle. Mutations serialize on a per-handle promise
* chain; reads re-scan the artifact on demand and never observe a shorter log
* than a prior read on this handle. Routed live events buffer in a bounded
* window and drain through the same chain as explicit appends.
*/
var JsonlSessionHandle = class {
	storage;
	id;
	header;
	access;
	state;
	lease;
	chain = Promise.resolve();
	closing;
	observedLength = 0;
	/** Routed live events awaiting their batching deadline (persistence-owned copies). */
	buffered = [];
	batchTimer;
	/** Set when a drain failed; the automatic timer stays quiet until the next drain. */
	drainPaused = false;
	draining;
	constructor(storage, id, header, access, state, lease) {
		this.storage = storage;
		this.id = id;
		this.header = header;
		this.access = access;
		this.state = state;
		this.lease = lease;
	}
	/** Exact fork-inherited prefix length stored with this session's log. */
	get inheritedEventCount() {
		return this.state.inheritedEventCount;
	}
	/**
	* Read a slice of the valid contiguous logical log; see the seam contract.
	* @param offset - first logical seq to include (default 0).
	* @param length - maximum events returned (default: the rest).
	* @param options - optional cancellation.
	* @returns a slice carrying the aliasing state established by its producer.
	*/
	async read(offset = 0, length = Number.MAX_SAFE_INTEGER, options) {
		this.assertOpen("read");
		if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError(`read offset must be a non-negative safe integer, got ${String(offset)}`);
		if (!Number.isSafeInteger(length) || length < 0) throw new TypeError(`read length must be a non-negative safe integer, got ${String(length)}`);
		options?.signal?.throwIfAborted();
		let result;
		const primed = this.state.primed;
		if (primed !== void 0) {
			if (this.access === "write") result = this.readPrimed(primed, offset, length);
			else {
				const currentPath = await this.storage.resolveCurrentLog(this.id, options?.signal);
				if (currentPath === void 0) result = this.readPrimed(primed, offset, length);
				else {
					this.state.primed = void 0;
					result = await this.readCurrent(currentPath, offset, length, options?.signal);
				}
			}
		} else if (this.access === "write" && !this.state.materialized) result = {
			eventState: "detached",
			events: []
		};
		else {
			const currentPath = await this.storage.resolveCurrentLog(this.id, options?.signal);
			if (currentPath !== void 0) result = await this.readCurrent(currentPath, offset, length, options?.signal);
			else if (this.storage.hasPendingSession(this.id)) result = {
				eventState: "detached",
				events: []
			};
			else throw new SessionPersistenceNotFoundError(this.id);
		}
		return result;
	}
	/** Read one slice from the prepared historical prefix retained by this handle. */
	readPrimed(source, offset, length) {
		this.observedLength = Math.max(this.observedLength, source.events.length);
		return {
			eventState: source.eventState,
			events: source.events.slice(offset, offset + length)
		};
	}
	/** Read one current physical generation and enforce this handle's monotonic view. */
	async readCurrent(path, offset, length, signal) {
		const source = await this.storage.readStoredLog(path, this.id, signal);
		if (source.events.length < this.observedLength) throw new Error(`session "${this.id}": stored log shrank below a previously observed prefix (${source.events.length} < ${this.observedLength})`);
		this.observedLength = source.events.length;
		return {
			eventState: source.eventState,
			events: source.events.slice(offset, offset + length)
		};
	}
	/**
	* Durably append a contiguous batch; see the seam contract.
	* @param events - the contiguous batch in seq order.
	* @param options - optional cancellation observed before the write starts.
	*/
	async append(events, options) {
		this.assertOpen("append");
		const batch = materializeAppendBatch(events);
		return this.run("append", async () => {
			options?.signal?.throwIfAborted();
			await this.persistContiguous(batch);
		});
	}
	/**
	* Durability barrier; materializes the artifact when nothing has been
	* appended yet, so an explicitly flushed empty session survives this process.
	* @param options - optional cancellation observed before the barrier starts.
	*/
	flush(options) {
		return this.run("flush", async () => {
			options?.signal?.throwIfAborted();
			if (this.access !== "write") throw new SessionReadOnlyError(this.id, "flush");
			if (this.state.materialized) return;
			await this.ensureLease();
			await this.storage.persistHeader(this.header, this.state.inheritedEventCount);
			this.state.materialized = true;
		});
	}
	/**
	* Release the handle; see the seam contract. Idempotent and uncancellable.
	* A write handle first drains its routed live buffer through the still-open
	* storage, so backend teardown loses nothing regardless of which fiber
	* unwinds first; a drain or lock-release failure still frees the in-process
	* claim, then rejects — both failures together reject as one
	* `AggregateError`.
	* @returns settlement of the release.
	*/
	close() {
		return this.closing ??= (async () => {
			let drainFailure;
			for (;;) {
				try {
					await this.drainLive();
				} catch (error) {
					drainFailure = error;
					break;
				}
				await this.chain;
				if (this.buffered.length === 0) break;
			}
			await this.chain;
			const failures = [];
			if (drainFailure !== void 0) failures.push(drainFailure instanceof Error ? drainFailure : new Error(errorChain(drainFailure)));
			try {
				await this.lease?.release();
			} catch (releaseFailure) {
				/* v8 ignore next -- lock releases reject with Error */
				failures.push(releaseFailure instanceof Error ? releaseFailure : new Error(errorChain(releaseFailure)));
			}
			this.storage.releaseHandle(this, this.state.materialized);
			if (failures.length > 1) throw new AggregateError(failures, `session "${this.id}": close failed to drain and to release its write lock`);
			if (failures[0] !== void 0) throw failures[0];
		})();
	}
	/** `await using` support: delegates to {@link close}. */
	[Symbol.asyncDispose]() {
		return this.close();
	}
	/**
	* Buffer one published live session event and arm the bounded batching
	* window when it is idle. The routing installer is the only caller.
	* @param event - the live event, retained as a persistence-owned copy.
	* @param reportBackgroundFailure - observes a deadline-driven drain failure
	*   (the events stay buffered; the next {@link drainLive} retries loudly).
	*/
	enqueueLive(event, reportBackgroundFailure) {
		this.buffered.push(structuredClone(event));
		if (this.batchTimer !== void 0 || this.drainPaused) return;
		this.batchTimer = setTimeout(() => {
			this.batchTimer = void 0;
			this.drainLive().catch(reportBackgroundFailure);
		}, 200);
	}
	/**
	* Durably drain the routed live buffer through the mutation chain;
	* concurrent callers join one drain, and a failure retains the batch in
	* order so `session/flush` can retry and reject loudly.
	*/
	drainLive() {
		return this.draining ??= this.drainBuffered().finally(() => {
			this.draining = void 0;
		});
	}
	async drainBuffered() {
		if (this.batchTimer !== void 0) {
			clearTimeout(this.batchTimer);
			this.batchTimer = void 0;
		}
		this.drainPaused = false;
		while (this.buffered.length > 0) await this.enqueueChain(async () => {
			const batch = this.buffered.splice(0);
			try {
				await this.persistContiguous(materializeAppendBatch(batch));
			} catch (error) {
				this.buffered = batch.concat(this.buffered);
				this.drainPaused = true;
				throw error;
			}
		});
	}
	/** The shared durable-append body: contiguity, ownership, torn-tail repair, storage write, state advance. */
	async persistContiguous(batch) {
		if (this.access !== "write") throw new SessionReadOnlyError(this.id, "append");
		if (batch.length === 0) return;
		await this.ensureLease();
		assertContiguous(this.id, batch, this.state.cursor);
		if (this.state.tornTruncateTo !== void 0) {
			await this.storage.truncateTornTail(this.header, this.state.tornTruncateTo);
			this.state.tornTruncateTo = void 0;
		}
		if (this.state.recoveredTail !== void 0) {
			if (this.state.recoveredTail.length > 0) await this.storage.persistBatch(this.header, this.state.recoveredTail, this.state.materialized, this.state.inheritedEventCount);
			this.state.recoveredTail = void 0;
		}
		await this.storage.persistBatch(this.header, batch, this.state.materialized, this.state.inheritedEventCount);
		this.state.materialized = true;
		this.state.cursor += batch.length;
		this.state.primed = void 0;
		this.observedLength = this.state.cursor;
	}
	/**
	* Hold the cross-process write lock before this session's first durable
	* write. An open write handle holds it from construction; a create handle
	* acquires it here — immediately before the first log bytes publish — and
	* keeps it through close even when materialization then fails, so a
	* materializing session stays exclusively owned across retries.
	*/
	async ensureLease() {
		this.lease ??= await this.storage.acquireWriteLease(this.header);
	}
	/** Serialize one operation onto the chain without the closed-handle refusal (drain-from-close). */
	enqueueChain(op) {
		const next = this.chain.then(op);
		this.chain = next.catch(() => {});
		return next;
	}
	/** Serialize one public mutating operation onto this handle's chain. */
	async run(operation, op) {
		this.assertOpen(operation);
		return this.enqueueChain(async () => {
			this.assertOpen(operation);
			return op();
		});
	}
	assertOpen(operation) {
		if (this.closing !== void 0) throw new SessionHandleClosedError(this.id, operation);
	}
};
/**
* The JSONL backend's in-process bookkeeping: the single active writer per
* session id (doubling as the live event router), the open-handle set the
* teardown sweep closes, and the created-but-unmaterialized sessions this
* process can already observe.
*/
var JsonlBackendTracker = class {
	name;
	/** Every open handle; teardown closes what remains. */
	openHandles = /* @__PURE__ */ new Set();
	/** `null` marks a claim whose handle is still being constructed. */
	writers = /* @__PURE__ */ new Map();
	pending = /* @__PURE__ */ new Map();
	counter = 0;
	/** @param name - backend label used in in-memory revision tokens and teardown errors. */
	constructor(name) {
		this.name = name;
	}
	/**
	* Claim write ownership and record the created session as pending, making
	* it observable to this process before it materializes. Before
	* materialization this registration is the only guard — session ids do not
	* collide across processes, and no durable artifact exists for another
	* process to open; the handle takes the cross-process lock at its first
	* materializing write.
	* @param header - the validated detached header.
	* @param inheritedEventCount - the exact fork-inherited prefix length.
	* @throws {SessionAlreadyExistsError} when a concurrent create or an open
	*   write handle holds the id — for create, the duplicate is the fact.
	*/
	registerCreated(header, inheritedEventCount) {
		if (this.writers.has(header.id)) throw new SessionAlreadyExistsError(header.id);
		this.writers.set(header.id, null);
		this.pending.set(header.id, {
			header,
			revision: SessionPersistenceRevision(`memory:${this.name}:${++this.counter}`),
			inheritedEventCount
		});
	}
	/**
	* Claim write ownership for an existing session.
	* @param id - the session to claim.
	* @throws {SessionAlreadyOwnedError} when an active write handle exists.
	*/
	claimWrite(id) {
		if (this.writers.has(id)) throw new SessionAlreadyOwnedError(id);
		this.writers.set(id, null);
	}
	/**
	* Roll a failed write open back.
	* @param id - the session whose claim is dropped.
	*/
	releaseClaim(id) {
		this.writers.delete(id);
	}
	/**
	* The pending entry for a created-but-unmaterialized session, if any.
	* @param id - the session to look up.
	* @returns the pending header and in-memory revision.
	*/
	pendingOf(id) {
		return this.pending.get(id);
	}
	/**
	* Whether this process still tracks a created-but-unmaterialized session.
	* @param id - the session to test.
	* @returns true while the pending entry exists.
	*/
	hasPending(id) {
		return this.pending.has(id);
	}
	/**
	* Iterate the pending sessions for listing.
	* @returns the pending entries, keyed by session id.
	*/
	pendingEntries() {
		return this.pending.entries();
	}
	/**
	* Drop a pending entry once the session materialized durably.
	* @param id - the session that reached durable storage.
	*/
	materialized(id) {
		this.pending.delete(id);
	}
	/**
	* Track one open handle for teardown and, for a write handle, bind it as
	* the session's live event route.
	* @param handle - the just-constructed handle.
	* @returns the same handle, for construction-site chaining.
	*/
	adopt(handle) {
		this.openHandles.add(handle);
		if (handle.access === "write") this.writers.set(handle.id, handle);
		return handle;
	}
	/**
	* Release one handle's bookkeeping on close. A write handle drops its
	* ownership claim; a creator that never materialized leaves nothing behind —
	* the session never existed.
	* @param handle - the closing handle.
	* @param materialized - whether the session reached durable storage.
	*/
	release(handle, materialized) {
		this.openHandles.delete(handle);
		if (handle.access !== "write") return;
		this.writers.delete(handle.id);
		if (!materialized) this.pending.delete(handle.id);
	}
	/**
	* Drain and flush every active write handle — the service-wide durability
	* barrier behind `SessionPersistence.flush`.
	* @throws {AggregateError} naming each session whose flush failed; the
	*   remaining handles still flush.
	*/
	async flushAll() {
		const errors = [];
		for (const writer of [...this.writers.values()]) {
			if (writer === null) continue;
			try {
				await writer.drainLive();
				await writer.flush();
			} catch (error) {
				if (error instanceof SessionHandleClosedError) continue;
				errors.push(error);
			}
		}
		if (errors.length > 0) throw new AggregateError(errors, `${this.name} flush failed`);
	}
	/**
	* Install the backend's live session routing and teardown. Persistence
	* enforces one active write handle per id, so the listeners route published
	* sessions' events by id; the teardown effect closes every open handle —
	* close drains the routed buffer — and aggregates failures. This provider
	* owns no separate storage connection, so closing handles is the complete
	* teardown. The returned effect removes listeners before closing handles.
	* @param ctx - the backend's resource-owning context.
	* @returns the disposer to run after persistence consumers finish unloading.
	*/
	install(ctx) {
		const { writers, openHandles, name } = this;
		return ctx.effect(function* () {
			yield async () => {
				const errors = [];
				for (const handle of [...openHandles]) try {
					await handle.close();
				} catch (error) {
					errors.push(error);
				}
				if (errors.length > 0) throw new AggregateError(errors, `${name} dispose failed`);
			};
			yield ctx.on("session/event", (session, event) => {
				writers.get(session.id)?.enqueueLive(event, (error) => {
					ctx.logger.warn(`session-persistence: background write for session "${session.id}" failed (buffered events retained): ${String(error)}`);
				});
			});
			yield ctx.on("session/flush", (session) => {
				const writer = writers.get(session.id);
				if (writer === null || writer === void 0) return void 0;
				return (async () => {
					await writer.drainLive();
					await writer.flush();
				})();
			});
			yield ctx.on("session/disposed", (session) => {
				const writer = writers.get(session.id);
				if (writer === null || writer === void 0) return;
				writer.close().catch((error) => {
					ctx.logger.warn(`session-persistence: final drain for session "${session.id}" failed: ${String(error)}`);
				});
			});
		}, `${this.name} live routing and open handles`);
	}
};
//#endregion
export { JsonlBackendTracker, JsonlSessionHandle, LIVE_WRITE_BATCH_MAX_DELAY_MS };
