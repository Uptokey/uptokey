export interface WorkspaceBrowserIdentity { privateKey: CryptoKey; publicJwk: JsonWebKey; }
/** Returns the existing origin-local nonextractable signing identity. Never stores a bearer. */
export function workspaceBrowserIdentity(): Promise<WorkspaceBrowserIdentity>;
