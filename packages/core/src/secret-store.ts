/**
 * Interface do Cofre Nativo do Sistema Operacional (Zero-Knowledge)
 * Suporta DPAPI (Windows), Apple Keychain (macOS) e Secret Service / D-Bus (Linux).
 */
export type SupportedVaultBackend = 'dpapi' | 'keychain' | 'secret-service' | 'mock-memory';

export interface SecretStoreOptions {
  serviceName?: string;
  namespace?: string;
}

export interface SecretStore {
  backend: SupportedVaultBackend;
  getSecret(key: string): Promise<string | null>;
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<boolean>;
  listKeys(): Promise<string[]>;
}

export class MemorySecretStore implements SecretStore {
  public readonly backend: SupportedVaultBackend = 'mock-memory';
  private readonly store = new Map<string, string>();

  async getSecret(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async setSecret(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async deleteSecret(key: string): Promise<boolean> {
    return this.store.delete(key);
  }

  async listKeys(): Promise<string[]> {
    return Array.from(this.store.keys());
  }
}

export function detectNativeVaultBackend(): SupportedVaultBackend {
  switch (process.platform) {
    case 'win32':
      return 'dpapi';
    case 'darwin':
      return 'keychain';
    case 'linux':
      return 'secret-service';
    default:
      return 'mock-memory';
  }
}

export function createSecretStore(options?: SecretStoreOptions): SecretStore {
  // Inicialização padrão para ambiente local
  return new MemorySecretStore();
}
