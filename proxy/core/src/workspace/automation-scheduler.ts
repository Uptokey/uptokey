/**
 * E2-13.C — scheduler + idempotent occurrences with injectable fake clock.
 */

import { AutomationError, type Clock, SystemClock, isId } from "./automation-types.ts";

export type ScheduleKind = "interval_ms" | "cron_daily_minute";

export type AutomationSchedule = {
  id: string;
  principalId: string;
  projectId: string;
  presetId: string;
  presetVersion: number;
  kind: ScheduleKind;
  /** interval_ms: period; cron_daily_minute: minute-of-day 0..1439 in clock zone. */
  value: number;
  enabled: boolean;
  createdAt: string;
  /** Terminal revocation: never fires again, persists across restarts. */
  revokedAt?: string | null;
};

export type OccurrenceStatus = "scheduled" | "claimed" | "prepared" | "submitted" | "succeeded" | "failed" | "skipped_duplicate";
export type ScheduledRunReference={planId:string;runId:string;grantId:string;requestId:string};
export type ScheduledPreparationResult={planIds:string[];runRefs?:ScheduledRunReference[]};

export type ScheduleOccurrence = {
  id: string;
  scheduleId: string;
  /** Idempotency key: scheduleId + scheduledAtIso */
  occurrenceKey: string;
  scheduledAt: string;
  status: OccurrenceStatus;
  claimedAt?: string;
  finishedAt?: string;
  errorCode?: string;
  /** Canonical W5 plans awaiting their own consent; not execution receipts. */
  planIds?: string[];
  runRefs?: ScheduledRunReference[];
};

function occurrenceKey(scheduleId: string, scheduledAt: string): string {
  return `${scheduleId}@${scheduledAt}`;
}

function startOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

export class AutomationScheduler {
  private schedules = new Map<string, AutomationSchedule>();
  private occurrences = new Map<string, ScheduleOccurrence>(); // by occurrenceKey
  private seq = 0;
  private readonly clock: Clock;

  constructor(clock: Clock = new SystemClock()) {
    this.clock = clock;
  }

  createSchedule(input: {
    principalId: string;
    projectId: string;
    presetId: string;
    presetVersion: number;
    kind: ScheduleKind;
    value: number;
  }): AutomationSchedule {
    if (!isId(input.principalId) || !isId(input.projectId) || !isId(input.presetId)) {
      throw new AutomationError("schedule_ids_invalid");
    }
    if (input.kind === "interval_ms" && (!Number.isSafeInteger(input.value) || input.value < 1_000)) {
      throw new AutomationError("interval_too_small");
    }
    if (input.kind === "cron_daily_minute" && (!Number.isSafeInteger(input.value) || input.value < 0 || input.value > 1439)) {
      throw new AutomationError("cron_minute_invalid");
    }
    if (!Number.isSafeInteger(input.presetVersion) || input.presetVersion < 1) {
      throw new AutomationError("preset_version_invalid");
    }
    const schedule: AutomationSchedule = {
      id: `sched_${(++this.seq).toString(36)}`,
      principalId: input.principalId,
      projectId: input.projectId,
      presetId: input.presetId,
      presetVersion: input.presetVersion,
      kind: input.kind,
      value: input.value,
      enabled: true,
      createdAt: this.clock.now().toISOString(),
    };
    this.schedules.set(schedule.id, schedule);
    return structuredClone(schedule);
  }

  getSchedule(id: string): AutomationSchedule | undefined {
    const s = this.schedules.get(id);
    return s ? structuredClone(s) : undefined;
  }

  listSchedules(principalId: string, projectId: string): AutomationSchedule[] {
    return [...this.schedules.values()].filter(s => s.principalId === principalId && s.projectId === projectId).map(s => structuredClone(s));
  }

  setEnabled(id: string, enabled: boolean): AutomationSchedule {
    const s = this.schedules.get(id);
    if (!s) throw new AutomationError("schedule_missing", 404);
    if (s.revokedAt && enabled) throw new AutomationError("schedule_revoked", 409);
    s.enabled = enabled;
    return structuredClone(s);
  }

  /** Terminal revocation: disables and blocks re-enable; idempotent. */
  revoke(id: string): AutomationSchedule {
    const s = this.schedules.get(id);
    if (!s) throw new AutomationError("schedule_missing", 404);
    s.revokedAt ??= this.clock.now().toISOString();
    s.enabled = false;
    return structuredClone(s);
  }

  /**
   * Recovery: a `claimed` occurrence was persisted before its effect, so no
   * remote effect can exist; settle it without ever re-firing the slot.
   */
  reconcileInterrupted(): number {
    let settled = 0;
    for (const occ of [...this.occurrences.values()]) {
      if (occ.status !== "claimed") continue;
      this.complete(occ.occurrenceKey, "failed", "interrupted_claim");
      settled += 1;
    }
    return settled;
  }

  /** Materialize due occurrences up to clock.now() without executing effects. */
  tick(): ScheduleOccurrence[] {
    const now = this.clock.now();
    const created: ScheduleOccurrence[] = [];
    for (const schedule of this.schedules.values()) {
      if (!schedule.enabled || schedule.revokedAt) continue;
      const dueAts = this.dueTimestamps(schedule, now);
      for (const at of dueAts) {
        const key = occurrenceKey(schedule.id, at.toISOString());
        if (this.occurrences.has(key)) continue;
        const occ: ScheduleOccurrence = {
          id: `occ_${(++this.seq).toString(36)}`,
          scheduleId: schedule.id,
          occurrenceKey: key,
          scheduledAt: at.toISOString(),
          status: "scheduled",
        };
        this.occurrences.set(key, occ);
        created.push(structuredClone(occ));
      }
    }
    return created;
  }

  private dueTimestamps(schedule: AutomationSchedule, now: Date): Date[] {
    const created = Date.parse(schedule.createdAt);
    const latest = Math.max(created, ...[...this.occurrences.values()].filter(occurrence=>occurrence.scheduleId===schedule.id).map(occurrence=>Date.parse(occurrence.scheduledAt)));
    if (schedule.kind === "interval_ms") {
      const out: Date[] = [];
      let t = latest + schedule.value;
      // Cap fan-out per tick to avoid pathological catch-up
      let guard = 0;
      while (t <= now.getTime() && guard < 64) {
        out.push(new Date(t));
        t += schedule.value;
        guard += 1;
      }
      return out;
    }
    // cron_daily_minute: one slot per UTC day at minute offset
    const out: Date[] = [];
    let day = startOfDay(new Date(latest));
    let guard = 0;
    while (guard < 64) {
      const slot = new Date(day.getTime() + schedule.value * 60_000);
      if (slot.getTime() > latest && slot.getTime() <= now.getTime()) out.push(slot);
      if (day.getTime() > now.getTime()) break;
      day = new Date(day.getTime() + 86_400_000);
      guard += 1;
    }
    return out;
  }

  /**
   * Claim occurrence idempotently. Second claim with same key returns skipped_duplicate
   * without re-running the handler.
   */
  claim(occurrenceKeyValue: string): { occurrence: ScheduleOccurrence; claimed: boolean } {
    const occ = this.occurrences.get(occurrenceKeyValue);
    if (!occ) throw new AutomationError("occurrence_missing", 404);
    if (occ.status !== "scheduled") {
      return { occurrence: structuredClone(occ), claimed: false };
    }
    occ.status = "claimed";
    occ.claimedAt = this.clock.now().toISOString();
    return { occurrence: structuredClone(occ), claimed: true };
  }

  complete(occurrenceKeyValue: string, status: "succeeded" | "failed", errorCode?: string): ScheduleOccurrence {
    const occ = this.occurrences.get(occurrenceKeyValue);
    if (!occ) throw new AutomationError("occurrence_missing", 404);
    if (occ.status === "succeeded" || occ.status === "failed") {
      // idempotent complete
      return structuredClone(occ);
    }
    if (occ.status !== "claimed") throw new AutomationError("occurrence_not_claimed", 409);
    occ.status = status;
    occ.finishedAt = this.clock.now().toISOString();
    if (errorCode) occ.errorCode = errorCode;
    return structuredClone(occ);
  }

  /** Run due work with an effect callback; duplicates do not invoke effect. */
  async dispatchDue(effect: (occ: ScheduleOccurrence, schedule: AutomationSchedule) => Promise<void | ScheduledPreparationResult>, persistClaim?: () => void): Promise<{
    ran: number;
    skipped: number;
  }> {
    this.tick();
    let ran = 0;
    let skipped = 0;
    for (const occ of [...this.occurrences.values()]) {
      if (occ.status !== "scheduled") continue;
      const schedule = this.schedules.get(occ.scheduleId);
      if (!schedule || schedule.enabled === false || schedule.revokedAt) continue;
      const { claimed, occurrence } = this.claim(occ.occurrenceKey);
      if (!claimed) {
        skipped += 1;
        continue;
      }
      const claimedSchedule = this.schedules.get(occurrence.scheduleId);
      if (!claimedSchedule) {
        this.complete(occurrence.occurrenceKey, "failed", "schedule_missing");
        continue;
      }
      // Persist the claim before preparing anything. Interrupted claims stay visible,
      // never automatically replay an effect with an unknown outcome after reload.
      persistClaim?.();
      try {
        const result = await effect(occurrence, claimedSchedule);
        if (result) {
          if (!result.planIds.length || result.planIds.some(id => !isId(id))) throw new AutomationError('automation_plan_missing');
          const saved = this.occurrences.get(occurrence.occurrenceKey)!;
          if(result.runRefs?.some(ref=>![ref.planId,ref.runId,ref.grantId,ref.requestId].every(isId)||!result.planIds.includes(ref.planId)))throw new AutomationError('automation_run_reference_invalid');
          saved.status = result.runRefs?.length?'submitted':'prepared'; saved.planIds = [...result.planIds]; saved.finishedAt = this.clock.now().toISOString();
          if(result.runRefs?.length)saved.runRefs=structuredClone(result.runRefs);
        } else this.complete(occurrence.occurrenceKey, "succeeded");
        ran += 1;
      } catch (err) {
        const code = err instanceof AutomationError ? err.code : "occurrence_failed";
        this.complete(occurrence.occurrenceKey, "failed", code);
      }
    }
    return { ran, skipped };
  }

  listOccurrences(scheduleId: string): ScheduleOccurrence[] {
    return [...this.occurrences.values()]
      .filter((o) => o.scheduleId === scheduleId)
      .map((o) => structuredClone(o));
  }

  /** Durable persistence (E2-13 correção): agenda + ocorrências + seq. */
  exportState(): {
    schedules: Array<[string, AutomationSchedule]>;
    occurrences: Array<[string, ScheduleOccurrence]>;
    seq: number;
  } {
    return {
      schedules: [...this.schedules.entries()],
      occurrences: [...this.occurrences.entries()],
      seq: this.seq,
    };
  }

  restoreState(state: {
    schedules: Array<[string, AutomationSchedule]>;
    occurrences: Array<[string, ScheduleOccurrence]>;
    seq: number;
  }): void {
    this.schedules = new Map(state.schedules);
    this.occurrences = new Map(state.occurrences);
    this.seq = state.seq;
  }
}
