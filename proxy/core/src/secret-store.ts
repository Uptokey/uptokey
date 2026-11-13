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

type SecretStoreOperation = "read" | "write" | "delete";

/** Public classification only; never retain the native exception or vault data. */
export class SecureStorageFullError extends Error {
  readonly code = "secure_storage_full" as const;
  constructor(operation: SecretStoreOperation) {
    // Existing callers intentionally match these operation-level messages.
    super(`secret_store_${operation}_unavailable`);
    this.name = "SecureStorageFullError";
  }
}

/** Follow only bounded, data-valued Error links; preserve rollback errors intact. */
export function secretStoreFailureCode(error: unknown): "secure_storage_full" | undefined {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: error, depth: 0 }];
  const seen = new Set<Error>();
  for (let visited = 0; pending.length && visited < 16; visited++) {
    const { value, depth } = pending.shift()!;
    if (!(value instanceof Error) || seen.has(value)) continue;
    if (value instanceof SecureStorageFullError) return value.code;
    seen.add(value);
    if (depth >= 4) continue;
    const cause = Object.getOwnPropertyDescriptor(value, "cause");
    if (cause && "value" in cause) pending.push({ value: cause.value, depth: depth + 1 });
    if (value instanceof AggregateError) {
      const errors = Object.getOwnPropertyDescriptor(value, "errors");
      if (errors && "value" in errors && Array.isArray(errors.value)) {
        for (const child of errors.value.slice(0, 16 - visited)) pending.push({ value: child, depth: depth + 1 });
      }
    }
  }
}

function nativeOperationError(error: unknown, operation: SecretStoreOperation, platform: NodeJS.Platform): Error {
  if (platform === "win32" && error instanceof Error) {
    const code = Object.getOwnPropertyDescriptor(error, "code");
    const message = Object.getOwnPropertyDescriptor(error, "message");
    // This is the observed keyring binding's exact Windows ERROR_NOT_ENOUGH_MEMORY
    // envelope. Do not infer capacity from arbitrary "8", localized text or paths.
    if (code && "value" in code && code.value === "GenericFailure" && message && "value" in message && typeof message.value === "string" &&
      message.value.replace(/\r\n/g, "\n") === "Platform failure: Windows error code 8\n\nCaused by:\n    Windows error code 8") {
      return new SecureStorageFullError(operation);
    }
  }
  return new Error(`secret_store_${operation}_unavailable`);
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
  private readonly platform: NodeJS.Platform;
  constructor(entryFactory: (service: string, account: string) => PasswordEntry | Promise<PasswordEntry> = nativeEntry, platform: NodeJS.Platform = process.platform) { this.entryFactory = entryFactory; this.platform = platform; }
  async get(account: string): Promise<string | undefined> {
    try {
      // Only null means absent; an empty stored value must reach validation.
      return (await this.entryFactory(service, account)).getPassword() ?? undefined;
    } catch (error) { throw nativeOperationError(error, "read", this.platform); }
  }

  async set(account: string, value: string): Promise<void> {
    try { (await this.entryFactory(service, account)).setPassword(value); }
    catch (error) { throw nativeOperationError(error, "write", this.platform); }
  }

  async delete(account: string): Promise<void> {
    try { (await this.entryFactory(service, account)).deletePassword(); }
    catch (error) { throw nativeOperationError(error, "delete", this.platform); }
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

  if (platform === "win32") return new NativeSecretStore(dynamicFactory, platform);
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
