/** Shared browser identity for the PWA and local setup page. No bearer is stored.
 * Keep this function self-contained: the core embeds this same source in its CSP
 * nonced setup script. Existing IndexedDB keys/schema are reused, never migrated.
 */
export async function workspaceBrowserIdentity() {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('quimera.workspace.identity.v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('identity');
    request.onerror = () => reject(new Error('workspace_identity_unavailable'));
    request.onblocked = () => reject(new Error('workspace_identity_blocked'));
    request.onsuccess = () => resolve(request.result);
  });
  function validate(value) {
    if (!value || value.privateKey?.extractable !== false || value.privateKey.type !== 'private' ||
        value.privateKey.algorithm.name !== 'ECDSA' || value.privateKey.algorithm.namedCurve !== 'P-256' ||
        value.publicJwk?.kty !== 'EC' || value.publicJwk.crv !== 'P-256' || 'd' in value.publicJwk) {
      throw new Error('workspace_identity_invalid');
    }
    return value;
  }
  try {
    const stored = await new Promise((resolve, reject) => {
      const request = db.transaction('identity', 'readonly').objectStore('identity').get('key');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('workspace_identity_unavailable'));
    });
    if (stored !== undefined) return validate(stored);
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const candidate = { privateKey: pair.privateKey, publicJwk: await crypto.subtle.exportKey('jwk', pair.publicKey) };
    // A read/write transaction selects a single winner for simultaneous tabs.
    const chosen = await new Promise((resolve, reject) => {
      const tx = db.transaction('identity', 'readwrite');
      const store = tx.objectStore('identity');
      const read = store.get('key');
      let value = candidate;
      read.onsuccess = () => { if (read.result !== undefined) value = read.result; else store.put(candidate, 'key'); };
      tx.oncomplete = () => resolve(value);
      tx.onerror = tx.onabort = () => reject(new Error('workspace_identity_unavailable'));
    });
    return validate(chosen);
  } finally { db.close(); }
}
