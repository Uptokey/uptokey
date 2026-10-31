import { mkdir, open, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tryLockExclusive } from "@deepseek-ai/node-addon-system/flock";
import { SessionAlreadyOwnedError } from "@deepseek-ai/dsh-session-persistence";
import { createHash } from "node:crypto";
//#region upstream/packages/session/session-persistence-jsonl/src/win32.ts
/**
* Windows durable namespace helpers for the JSONL backend.
*
* POSIX publishes a newly-created log by creating a directory entry and then
* fsyncing the parent directory. Windows does not expose that parent-directory
* fsync contract through Node, so the Windows path uses the native durable
* namespace primitive instead: create a staging object in the target directory
* and publish it with `MoveFileExW(..., MOVEFILE_WRITE_THROUGH)` without
* replacement or cross-volume copy fallback.
*
* @module dsh-session-persistence-jsonl/win32
*/
const WAIT_OBJECT_0 = 0;
const WAIT_TIMEOUT = 258;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_PATH_NOT_FOUND = 3;
const ERROR_ACCESS_DENIED = 5;
const ERROR_NOT_SAME_DEVICE = 17;
const ERROR_SHARING_VIOLATION = 32;
const ERROR_FILE_EXISTS = 80;
const ERROR_INVALID_NAME = 123;
const ERROR_ALREADY_EXISTS = 183;
let bindings;
/** Load the small Win32 API lazily so non-Windows processes never load Koffi. */
async function win32() {
	if (bindings !== void 0) return bindings;
	const kernel32 = (await import("koffi")).default.load("kernel32.dll");
	bindings = {
		moveFileExW: kernel32.func("__stdcall", "MoveFileExW", "int", [
			"str16",
			"str16",
			"uint"
		]),
		createSemaphoreW: kernel32.func("__stdcall", "CreateSemaphoreW", "intptr", [
			"void*",
			"int",
			"int",
			"str16"
		]),
		waitForSingleObject: kernel32.func("__stdcall", "WaitForSingleObject", "uint", ["intptr", "uint"]),
		releaseSemaphore: kernel32.func("__stdcall", "ReleaseSemaphore", "int", [
			"intptr",
			"int",
			"void*"
		]),
		closeHandle: kernel32.func("__stdcall", "CloseHandle", "int", ["intptr"]),
		getLastError: kernel32.func("__stdcall", "GetLastError", "uint", [])
	};
	return bindings;
}
function errnoCode(win32Code) {
	switch (win32Code) {
		case ERROR_FILE_NOT_FOUND:
		case ERROR_PATH_NOT_FOUND: return "ENOENT";
		case ERROR_ACCESS_DENIED: return "EACCES";
		case ERROR_NOT_SAME_DEVICE: return "EXDEV";
		case ERROR_SHARING_VIOLATION: return "EBUSY";
		case ERROR_FILE_EXISTS:
		case ERROR_ALREADY_EXISTS: return "EEXIST";
		case ERROR_INVALID_NAME: return "EINVAL";
		default: return "EIO";
	}
}
function win32Error(syscall, win32Code, path, dest) {
	const code = errnoCode(win32Code);
	const error = /* @__PURE__ */ new Error(`${syscall} ${code} (Win32 ${win32Code}): ${path} -> ${dest}`);
	error.code = code;
	error.errno = win32Code;
	error.syscall = syscall;
	error.path = path;
	error.dest = dest;
	error.win32Code = win32Code;
	return error;
}
/**
* Acquire the session write lock as a named kernel semaphore (count 1) whose
* name is derived from the canonical lock path. A kernel object never touches
* the filesystem, so readers, searches, and directory removal proceed freely
* while the lock is held; a second acquirer's zero-timeout wait times out
* (`EBUSY`); and when the last handle closes — including on any process
* death — the object is destroyed, so a successor's create starts fresh.
* @param path - the lock file path the name is derived from (case-folded:
*   Windows paths are case-insensitive).
* @returns the open semaphore handle, released via {@link releaseLockHandleWin32}.
*/
async function acquireLockHandleWin32(path) {
	const api = await win32();
	const name = `Local\\dsh-session-lock-${createHash("sha256").update(resolve(path).toLowerCase()).digest("hex")}`;
	const handle = api.createSemaphoreW(null, 1, 1, name);
	if (handle === 0) throw win32Error("CreateSemaphoreW", api.getLastError(), path, name);
	const wait = api.waitForSingleObject(handle, 0);
	if (wait === WAIT_OBJECT_0) return handle;
	api.closeHandle(handle);
	if (wait === WAIT_TIMEOUT) throw win32Error("WaitForSingleObject", ERROR_SHARING_VIOLATION, path, name);
	throw win32Error("WaitForSingleObject", api.getLastError(), path, name);
}
/**
* Release a lock from {@link acquireLockHandleWin32}: restore the semaphore
* count and close the handle (the object dies with its last handle).
* @param handle - the open semaphore handle.
*/
async function releaseLockHandleWin32(handle) {
	const api = await win32();
	const released = api.releaseSemaphore(handle, 1, null);
	const closed = api.closeHandle(handle);
	if (released === 0 || closed === 0) throw win32Error("ReleaseSemaphore", api.getLastError(), `handle:${handle}`, `handle:${handle}`);
}
//#endregion
//#region upstream/packages/session/session-persistence-jsonl/src/lease.ts
/**
* Cross-process write-ownership lock for one session's artifact directory,
* held for the whole life of a write handle. The arbiter is the kernel:
* POSIX takes a non-blocking `flock(2)` via native system support on `session.lock`
* beside the log, and Windows holds a named kernel semaphore derived from
* that path — never a file lock or handle, so readers, searches, and
* directory removal proceed freely while the lock is held. Contention maps
* to `SessionAlreadyOwnedError`; the kernel releases the lock when the
* holder's descriptor or last object handle closes, including on any process
* death, so a crashed holder never blocks a successor. A live but wedged
* holder keeps the lock until its process exits: there is deliberately no
* expiry that could expropriate a stalled writer whose resumed appends would
* tear the log.
* A POSIX lock names an inode, not a path, so after locking the holder
* verifies the locked inode is still the file at the lock path and retries
* otherwise: an unlinked-and-recreated lock file carries a fresh inode, and
* a lock on the orphaned one proves nothing. Removing a live session's lock
* file therefore forfeits exclusion on POSIX (nothing in the harness does
* so); Windows has no lock file at all. Readers never touch the lock.
* The lock is acquired at write-open of an existing artifact and, for a
* created session, only right before its first materializing write — an
* unmaterialized session has no filesystem footprint. Release never removes
* the POSIX lock file: every acquired lock belongs to a materialized or
* materializing session, and the surviving file keeps the stable inode later
* lockers verify against. The browser worker stubs the native flock entry to
* immediate success: it is single-process, so the in-process write claim
* already excludes every writer.
* @module @deepseek-ai/dsh-session-persistence-jsonl/lease
*/
/** Base name of the kernel lock file inside a session's directory. */
const LEASE_FILENAME = "session.lock";
/** Whether a flock failure means another descriptor holds the lock. */
function isLockContention(error) {
	const code = error?.code;
	return code === "EAGAIN" || code === "EWOULDBLOCK";
}
/**
* One held write lock. Constructed only by {@link SessionWriteLease.acquire};
* `release` closes the descriptor or handle, which is what releases the lock.
*/
var SessionWriteLease = class SessionWriteLease {
	held;
	released = false;
	constructor(held) {
		this.held = held;
	}
	/**
	* Acquire the session directory's kernel write lock.
	* @param dir - the session's artifact directory (created if absent).
	* @param id - the session the lock guards, for error identities.
	* @returns the held lock.
	* @throws {SessionAlreadyOwnedError} while another holder keeps the lock.
	*/
	static async acquire(dir, id) {
		const path = join(dir, LEASE_FILENAME);
		await mkdir(dir, {
			recursive: true,
			mode: 448
		});
		/* v8 ignore start -- native Windows coverage exercises this platform branch; Linux covers the POSIX peer */
		if (process.platform === "win32") {
			let handle;
			try {
				handle = await acquireLockHandleWin32(path);
			} catch (error) {
				if (error?.code === "EBUSY") throw new SessionAlreadyOwnedError(id);
				throw error;
			}
			return new SessionWriteLease({
				kind: "win32",
				handle
			});
		}
		/* v8 ignore stop */
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const handle = await open(path, "w");
			try {
				try {
					await tryLockExclusive(handle.fd);
				} catch (error) {
					if (isLockContention(error)) throw new SessionAlreadyOwnedError(id);
					throw error;
				}
				const held = await handle.stat({ bigint: true });
				const current = await stat(path, { bigint: true }).catch((error) => {
					if (error?.code === "ENOENT") return void 0;
					throw error;
				});
				if (current !== void 0 && current.ino === held.ino && current.dev === held.dev) return new SessionWriteLease({
					kind: "posix",
					handle
				});
			} catch (error) {
				await handle.close();
				throw error;
			}
			await handle.close();
		}
		throw new SessionAlreadyOwnedError(id);
	}
	/**
	* Release the kernel lock by closing its descriptor or handle. The POSIX
	* lock file is never removed: every acquired lock belongs to a
	* materialized or materializing session, and keeping the file preserves
	* the stable inode later lockers verify against. Idempotent.
	*/
	async release() {
		if (this.released) return;
		this.released = true;
		/* v8 ignore start -- native Windows coverage exercises this platform branch; Linux covers the POSIX peer */
		if (this.held.kind === "win32") {
			await releaseLockHandleWin32(this.held.handle);
			return;
		}
		/* v8 ignore stop */
		await this.held.handle.close();
	}
};
//#endregion
export { LEASE_FILENAME, SessionWriteLease };
