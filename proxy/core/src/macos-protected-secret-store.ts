import { lstatSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, normalize, parse } from "node:path";
import { fileURLToPath } from "node:url";
import { QUIMERA_SECRET_SERVICE } from "./paths.ts";

export const MAC_PROTECTED_BINDING_FILE = "uptokey-macos-protected-keyring.node";
export const MAC_PROTECTED_BINDING_CONTRACT = "uptokey-quimera-protected-store-v1";

export interface ProtectedEntry {
  getSecret(): Uint8Array | number[] | null;
  setSecret(secret: Uint8Array): void;
  deleteSecret(): boolean;
}

interface ProtectedBinding {
  protectedStoreContract(): string;
  ProtectedEntry: new (service: string, account: string) => ProtectedEntry;
}

// This is the internal native-loading seam for filesystem/module fixtures.
// Production never obtains these values from environment variables or IPC.
interface BindingRuntime {
  moduleUrl: string;
  load(path: string): unknown;
}
const runtime: BindingRuntime = { moduleUrl: import.meta.url, load: createRequire(import.meta.url) };
const entries = new Set(["cli.js", "composition-worker.js", "service-schema-worker.js", "workspace-context-helper.js"]);

function regularPath(path: string): void {
  if (!isAbsolute(path) || normalize(path) !== path || realpathSync(path) !== path) throw Error();
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size === 0) throw Error();
  let directory = dirname(path);
  for (;;) {
    const parent = lstatSync(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw Error();
    if (directory === parse(directory).root) break;
    directory = dirname(directory);
  }
}

/** Consumes only the adjacent artifact already admitted by the canonical host.
 * Layout validation is not signature evidence: packaging must sign the Node
 * process and binding, and include this binding in every consuming closure.
 */
export function macProtectedEntryFactory(service: string, executable: string, bindingRuntime: BindingRuntime = runtime): (account: string) => ProtectedEntry {
  try {
    if (service !== QUIMERA_SECRET_SERVICE && !/^com\.uptokey\.quimera\.proxy\.[a-z0-9][a-z0-9.-]{0,100}$/.test(service)) throw Error();
    const entry = fileURLToPath(bindingRuntime.moduleUrl);
    if (!entries.has(basename(entry)) || basename(executable) !== "uptokey" || dirname(entry) !== dirname(executable)) throw Error();
    const nativePath = join(dirname(entry), MAC_PROTECTED_BINDING_FILE);
    for (const path of [entry, executable, nativePath]) regularPath(path);
    const loaded = bindingRuntime.load(nativePath) as Partial<ProtectedBinding> | null;
    if (!loaded || typeof loaded.protectedStoreContract !== "function" || loaded.protectedStoreContract() !== MAC_PROTECTED_BINDING_CONTRACT || typeof loaded.ProtectedEntry !== "function") throw Error();
    const BindingEntry = loaded.ProtectedEntry;
    return account => new BindingEntry(service, account);
  } catch {
    throw new Error("quimera_macos_protected_keyring_unavailable");
  }
}
