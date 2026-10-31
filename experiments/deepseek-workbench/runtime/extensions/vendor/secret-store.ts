// Structural contract consumed by the unchanged Uptokey VaultCrypto sources.
// No personal OS keyring, namespace, or existing vault is imported by this lab.
export interface SecretStore {
  get(account: string): Promise<string | undefined>;
  set(account: string, value: string): Promise<void>;
  delete(account: string): Promise<void>;
}
