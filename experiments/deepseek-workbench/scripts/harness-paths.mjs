import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep, toNamespacedPath } from 'node:path';

export const HARNESS_STATE_ENV = 'UPTOKEY_HARNESS_STATE_ROOT';
const samePath = (left, right) => toNamespacedPath(left) === toNamespacedPath(right);
const inside = (parent, child) => {
  const rel = relative(parent, child);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
};

// Validate lexical ancestry as well as the final real path: a junction must not
// make an otherwise canonical-looking state directory point into resources.
function canonicalDirectory(value) {
  if (typeof value !== 'string' || !value || !isAbsolute(value)) throw Error('harness_state_path_invalid');
  const path = resolve(value);
  let canonical;
  try {
    canonical = realpathSync.native(path);
    if (!lstatSync(path).isDirectory() || !samePath(canonical, path)) throw Error('harness_state_path_invalid');
    for (let at = canonical;; at = dirname(at)) {
      if (lstatSync(at).isSymbolicLink()) throw Error('harness_state_path_invalid');
      if (dirname(at) === at) break;
    }
  } catch { throw Error('harness_state_path_invalid'); }
  // Node's native realpath removes the Windows extended-length prefix, while
  // Rust canonicalize supplies it. Use one representation for containment.
  return canonical;
}

/** No override preserves the exact development layout; nothing is migrated. */
export function harnessStateRoot(resourceRoot, environment = process.env) {
  if (environment[HARNESS_STATE_ENV] === undefined) return resolve(resourceRoot);
  const resources = canonicalDirectory(resourceRoot);
  const state = canonicalDirectory(environment[HARNESS_STATE_ENV]);
  if (inside(resources, state) || inside(state, resources)) throw Error('harness_state_overlap');
  return state;
}

/** Only Harness state namespaces are relocatable. Scripts and runtime stay immutable. */
export function statePath(resourceRoot, namespace, ...parts) {
  if (!['.local', 'output'].includes(namespace) || parts.some(part =>
    typeof part !== 'string' || !part || part === '.' || part === '..' || /[\\/:\0]/.test(part))) {
    throw Error('harness_state_namespace_invalid');
  }
  const base = harnessStateRoot(resourceRoot);
  const result = resolve(base, namespace, ...parts);
  if (process.env[HARNESS_STATE_ENV] !== undefined) {
    let at = base;
    for (const part of [namespace, ...parts]) {
      at = resolve(at, part);
      try {
        const stat = lstatSync(at);
        if (stat.isSymbolicLink() || !samePath(realpathSync.native(at), at)
          || (at !== result && !stat.isDirectory())) throw Error('harness_state_path_invalid');
      } catch (error) {
        if (error.code === 'ENOENT') break;
        throw Error('harness_state_path_invalid');
      }
    }
  }
  return result;
}
