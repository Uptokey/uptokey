import type { ProxyConfig } from "./types.ts";
import { loadConfig, updateConfig } from "./config.ts";

export const OFFLINE_GRACE_MS = 72 * 60 * 60 * 1_000;
export const CLOCK_ROLLBACK_TOLERANCE_MS = 5 * 60 * 1_000;

export interface OfflineDecision { allowed: boolean; code?: "offline_grace_expired" | "clock_rollback_detected" | "device_revoked" | "entitlement_suspended"; remainingMs?: number; }

export function offlineTtlEnabled(env = process.env): boolean {
  return env.UPTOKEY_OFFLINE_TTL_DISABLED !== "1";
}

export function evaluateOffline(config: ProxyConfig, now = new Date(), enabled = offlineTtlEnabled()): OfflineDecision {
  if (config.deviceRevokedAt) return { allowed: false, code: "device_revoked", remainingMs: 0 };
  if (config.entitlementSuspendedAt) return { allowed: false, code: "entitlement_suspended", remainingMs: 0 };
  if (!enabled) return { allowed: true };
  const lastContact = config.lastControlPlaneContact ? Date.parse(config.lastControlPlaneContact) : Number.NaN;
  const lastWall = config.lastObservedWallClock ? Date.parse(config.lastObservedWallClock) : Number.NaN;
  const current = now.getTime();
  if (Number.isFinite(lastWall) && current + CLOCK_ROLLBACK_TOLERANCE_MS < lastWall) return { allowed: false, code: "clock_rollback_detected" };
  if (Number.isFinite(lastContact) && current + CLOCK_ROLLBACK_TOLERANCE_MS < lastContact) return { allowed: false, code: "clock_rollback_detected" };
  // Sem uma configuração autenticada do control plane não existe entitlement
  // verificável nem instante confiável para iniciar o grace. O primeiro uso
  // permanece fail-closed; somente uma resposta autenticada pode abrir a janela.
  if (!Number.isFinite(lastContact)) return { allowed: false, code: "offline_grace_expired", remainingMs: 0 };
  const remainingMs = Math.max(0, lastContact + OFFLINE_GRACE_MS - current);
  return remainingMs > 0 ? { allowed: true, remainingMs } : { allowed: false, code: "offline_grace_expired", remainingMs: 0 };
}

export const WALL_CLOCK_PERSIST_INTERVAL_MS = 60 * 1_000;
let lastPersistedAt = 0;

/**
 * Avalia o grace do ADR-003 lendo a config do disco, e só então persiste o relógio observado.
 * O ADR-003 ratificado fica ativo por padrão. `UPTOKEY_OFFLINE_TTL_DISABLED=1` desliga SOMENTE
 * o TTL/grace e o anti-rollback (uso de desenvolvimento local) — NUNCA os gates de revogação de
 * device (§9.9) e suspensão de entitlement. Estes são gates separados por SPEC-020 §"gates
 * separados" e evaluateOffline os aplica antes de honrar `enabled`. Por isso guardOffline sempre
 * carrega a config: com o flag ligado a leitura permanece (é gate de segurança), mas a escrita
 * do relógio no caminho quente continua desligada.
 */
export async function guardOffline(now = new Date(), enabled = offlineTtlEnabled()): Promise<OfflineDecision> {
  const persisted = await loadConfig();
  const decision = evaluateOffline(persisted, now, enabled);
  if (enabled && decision.allowed && now.getTime() - lastPersistedAt >= WALL_CLOCK_PERSIST_INTERVAL_MS) {
    await updateConfig((latest) => { latest.lastObservedWallClock = now.toISOString(); });
    lastPersistedAt = now.getTime();
  }
  return decision;
}

export function resetWallClockThrottle(): void { lastPersistedAt = 0; }
