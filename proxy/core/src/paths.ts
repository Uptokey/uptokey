import { homedir } from "node:os";
import { lstatSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const QUIMERA_SECRET_SERVICE = "com.uptokey.quimera.proxy";

/** Reject the inherited variable instead of silently reusing a legacy profile. */
export function resolveQuimeraDataDir(env: Record<string, string | undefined>, home: string): string {
  if (env.UPTOKEY_DATA_DIR !== undefined) throw new Error("quimera_legacy_data_dir_override_forbidden");
  const path = env.UPTOKEY_QUIMERA_DATA_DIR ?? join(home, ".uptokey-quimera");
  return assertQuimeraDataPath(path);
}

/** No legacy directory or alias may be used, including junctions on Windows. */
export function assertQuimeraDataPath(path: string): string {
  if (!path.trim() || !isAbsolute(path)) throw new Error("quimera_data_path_must_be_absolute");
  const absolute = resolve(path);
  if (absolute.split(/[\\/]/).some((part) => part.replace(/[ .]+$/g, "").toLowerCase() === ".uptokey")) {
    throw new Error("quimera_legacy_data_path_forbidden");
  }
  let observed = absolute;
  while (true) {
    try {
      if (lstatSync(observed).isSymbolicLink()) throw new Error("quimera_data_path_alias_forbidden");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(observed);
    if (parent === observed) break;
    observed = parent;
  }
  return absolute;
}

export function dataDir(): string {
  return resolveQuimeraDataDir(process.env, homedir());
}

export function configPath(): string {
  return join(dataDir(), "proxy-config.json");
}

export function controlIdentityPath(): string {
  return join(dataDir(), "control-identity.json");
}

export function syncStatePath(): string { return join(dataDir(), "sync-state.json"); }

export function ledgerPath(): string {
  return join(dataDir(), "quota-ledger.json");
}

/** Durable estimate-vs-provider calibration aggregates (numeric only; never created in ephemeral mode). */
export function tokenCalibrationPath(): string { return join(dataDir(), "token-calibration.json"); }

export function exactCachePath(): string { return join(dataDir(), "exact-match-cache.json"); }


export function dpapiStorePath(): string {
  return join(dataDir(), "secrets.dpapi.json");
}

export function updateTransactionPath(): string { return join(dataDir(), "update-transaction.json"); }
export function proxyPidPath(): string { return join(dataDir(), "proxy.pid"); }

/** E2-02: perfis multicontas, provedores OAuth e idempotência (sem segredos). */
export function connectionProfilesPath(): string { return join(dataDir(), "connection-profiles.json"); }
/** E2-02: jobs de teste e instalação com cursor de progresso (sem segredos). */
export function connectionJobsPath(): string { return join(dataDir(), "connection-jobs.json"); }
/** E2-02: jobs de instalação de modelos locais (sem segredos). */
export function modelInstallJobsPath(): string { return join(dataDir(), "model-install-jobs.json"); }

/** E2-19: journal of pools/proxies/bindings/cursors/receipts (no secrets). */
export function egressJournalPath(): string {
  return join(dataDir(), "egress-journal.json");
}

/** E2-14: planos de instalacao persistidos para reload (sem segredos). */
export function installPlansPath(): string {
  return join(dataDir(), "install-plans.json");
}