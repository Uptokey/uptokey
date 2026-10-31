import { basename } from "node:path";
import type { LinuxPortalSecretStore } from "./linux-portal-secret-store.ts";
import { LINUX_PACKAGE_CHANNEL, type LinuxPackageChannel } from "./linux-distribution.ts";
import { QUIMERA_SECRET_SERVICE } from "./paths.ts";
import { DISTRIBUTION_CHANNEL, type DistributionChannel } from "./distribution-channel.ts";
import { macProtectedEntryFactory, type ProtectedEntry } from "./macos-protected-secret-store.ts";

const service = QUIMERA_SECRET_SERVICE;

/** An explicit native namespace isolates profiles without moving existing credentials. */
export function resolveOfficialSecretService(env: Record<string, string | undefined> = process.env): string {
  const selected = env.UPTOKEY_SECRET_SERVICE;
  if (selected === undefined || selected === QUIMERA_SECRET_SERVICE) return QUIMERA_SECRET_SERVICE;
  if (selected.length > 200 || !/^com\.uptokey\.quimera\.proxy\.[a-z0-9][a-z0-9.-]{0,100}$/.test(selected)) {
    throw new Error("uptokey_secret_service_invalid");
  }
  return selected;
}

// Loading this module or using an injected entry must never load a native vault.
async function nativeEntry(serviceName: string, account: string): Promise<PasswordEntry> {
  const native = await import("@napi-rs/keyring");
  return new native.Entry(serviceName, account);
}

export interface SecretStore {
  get(account: string): Promise<string | undefined>;
  set(account: string, value: string): Promise<void>;
  delete(account: string): Promise<void>;
}

export interface SecretStoreBoundary {
  mechanism: "memory" | "keychain-generic" | "macos-protected-data" | "windows-credential-manager" | "secret-service" | "linux-secret-portal" | "unknown";
  native: boolean;
  applicationBound: boolean;
}

export class MemorySecretStore implements SecretStore {
  readonly values = new Map<string, string>();
  async get(account: string) { return this.values.get(account); }
  async set(account: string, value: string) { this.values.set(account, value); }
  async delete(account: string) { this.values.delete(account); }
  securityBoundary(): SecretStoreBoundary { return { mechanism: "memory", native: false, applicationBound: false }; }
}

export class NativeSecretStore implements SecretStore {
  private readonly entryFactory: (service: string, account: string) => PasswordEntry | Promise<PasswordEntry>;
  constructor(entryFactory: (service: string, account: string) => PasswordEntry | Promise<PasswordEntry> = nativeEntry) { this.entryFactory = entryFactory; }
  async get(account: string): Promise<string | undefined> {
    try {
      // Only null means absent; an empty stored value must reach validation.
      return (await this.entryFactory(service, account)).getPassword() ?? undefined;
    } catch { throw new Error("secret_store_read_unavailable"); }
  }

  async set(account: string, value: string): Promise<void> {
    try { (await this.entryFactory(service, account)).setPassword(value); }
    catch { throw new Error("secret_store_write_unavailable"); }
  }

  async delete(account: string): Promise<void> {
    try { (await this.entryFactory(service, account)).deletePassword(); }
    catch { throw new Error("secret_store_delete_unavailable"); }
  }

  securityBoundary(platform = process.platform): SecretStoreBoundary {
    if (platform === "win32") return { mechanism: "windows-credential-manager", native: true, applicationBound: false };
    if (platform === "darwin") return { mechanism: "keychain-generic", native: true, applicationBound: false };
    if (platform === "linux") return { mechanism: "secret-service", native: true, applicationBound: false };
    return { mechanism: "unknown", native: true, applicationBound: false };
  }
}

interface PasswordEntry {
  getPassword(): string | null;
  setPassword(value: string): void;
  deletePassword(): boolean;
}

export class MacProtectedSecretStore implements SecretStore {
  private readonly entryFactory: (account: string) => ProtectedEntry;
  constructor(entryFactory: (account: string) => ProtectedEntry) { this.entryFactory = entryFactory; }
  async get(account: string): Promise<string | undefined> {
    let bytes: Uint8Array | undefined;
    try {
      const value = this.entryFactory(account).getSecret();
      if (!value) return undefined;
      bytes = value instanceof Uint8Array ? value : Uint8Array.from(value);
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch { throw new Error("secret_store_read_unavailable"); }
    finally { bytes?.fill(0); }
  }
  async set(account: string, value: string): Promise<void> {
    const bytes = new TextEncoder().encode(value);
    try { this.entryFactory(account).setSecret(bytes); }
    catch { throw new Error("secret_store_write_unavailable"); }
    finally { bytes.fill(0); }
  }
  async delete(account: string): Promise<void> { try { this.entryFactory(account).deleteSecret(); } catch { throw new Error("secret_store_delete_unavailable"); } }
  securityBoundary(): SecretStoreBoundary { return { mechanism: "macos-protected-data", native: true, applicationBound: true }; }
}

export function createOfficialSecretStore(platform = process.platform, executable = process.execPath, linuxChannel: LinuxPackageChannel = LINUX_PACKAGE_CHANNEL, serviceId = resolveOfficialSecretService(), distribution: DistributionChannel = DISTRIBUTION_CHANNEL): NativeSecretStore | MacProtectedSecretStore | LinuxPortalSecretStore {
  const dynamicFactory = async (serviceName: string, account: string) => nativeEntry(serviceId, account);

  if (platform === "win32") return new NativeSecretStore(dynamicFactory);
  // npm runs under the user's Node/Bun identity and uses the OS login vault.
  // It does not claim the application-bound protection of signed desktop/Flatpak.
  if (distribution === "npm" && isDevelopmentRuntime(executable) && linuxChannel !== "flatpak" && (platform === "linux" || platform === "darwin")) {
    return new NativeSecretStore(dynamicFactory);
  }
  if (platform === "linux") {
    if (linuxChannel === "deb") return new NativeSecretStore(dynamicFactory);
    // The packaged portal binding is not yet admitted for this data identity.
    // Do not silently downgrade an application-bound channel to Secret Service.
    throw new Error("quimera_linux_secret_portal_not_isolated");
  }
  if (platform !== "darwin") throw new Error("official_secret_store_platform_unsupported");
  
  // An npm runtime cannot opt into the signed desktop identity by renaming Node.
  if (distribution !== "native") throw new Error("quimera_macos_protected_keyring_not_isolated");
  return new MacProtectedSecretStore(macProtectedEntryFactory(serviceId, executable));
}

export function assertSecretStoreBoundary(
  boundary: SecretStoreBoundary,
  platform = process.platform,
  allowUnboundMacDevelopment = process.env.UPTOKEY_ALLOW_UNBOUND_KEYCHAIN_DEV === "1",
  developmentRuntime = isDevelopmentRuntime(process.execPath),
  linuxChannel: LinuxPackageChannel = LINUX_PACKAGE_CHANNEL,
  distribution: DistributionChannel = DISTRIBUTION_CHANNEL,
): void {
  if (!boundary.native) throw new Error("native_secret_store_required");
  if (distribution === "npm" && developmentRuntime && linuxChannel !== "flatpak") {
    const mechanism = platform === "darwin" ? "keychain-generic" : platform === "linux" ? "secret-service" : "windows-credential-manager";
    if (boundary.mechanism !== mechanism) throw new Error("npm_native_secret_store_required");
    return;
  }
  if (platform === "darwin" && !boundary.applicationBound && !(allowUnboundMacDevelopment && developmentRuntime)) throw new Error("macos_application_bound_keychain_required");
  if (platform === "linux" && !boundary.applicationBound && linuxChannel !== "deb" && !(allowUnboundMacDevelopment && developmentRuntime)) throw new Error("linux_application_bound_secret_service_required");
  if (platform === "linux" && linuxChannel === "deb" && boundary.mechanism !== "secret-service") throw new Error("linux_deb_secret_service_required");
}

export function isDevelopmentRuntime(executable: string): boolean {
  const base = basename(executable.replace(/\\/g, "/"));
  return /^(?:node|node\.exe|bun|bun\.exe)$/i.test(base);
}
