import { randomBytes, randomUUID } from "node:crypto";
import type { SecretStore } from "./secret-store.ts";

const prefix = "acceptance:";

export async function prepareKeychainAcceptance(secrets: SecretStore): Promise<{ account: string }> {
  const account = `${prefix}${randomUUID()}`;
  const canary = `uptokey-keychain-canary-${randomBytes(32).toString("base64url")}`;
  await secrets.set(account, canary);
  return { account };
}

export async function cleanupKeychainAcceptance(secrets: SecretStore, account: string): Promise<void> {
  if (!isAcceptanceAccount(account)) throw new Error("acceptance_account_invalid");
  await secrets.delete(account);
}

export function isAcceptanceAccount(account: string): boolean {
  return /^acceptance:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(account);
}
