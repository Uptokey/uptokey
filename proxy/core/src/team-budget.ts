/**
 * Operational team budget (requests/tokens), not a money ledger.
 * Distinct from QuotaLedger (provider local) and HostedUsageLedger (hosted money).
 * CAS/serialized reservations: concurrent last-seat contention has one winner.
 */
export interface TeamBudgetLimits {
  requests: number;
  tokens: number;
}

export interface TeamBudgetState {
  tenantId: string;
  revision: number;
  limits: TeamBudgetLimits;
  reserved: TeamBudgetLimits;
  settled: TeamBudgetLimits;
}

export interface TeamBudgetReservation {
  id: string;
  tenantId: string;
  requestId: string;
  principalId: string;
  requests: number;
  tokens: number;
  revisionAtReserve: number;
}

export type TeamBudgetDecision =
  | { ok: true; reservation: TeamBudgetReservation; state: TeamBudgetState }
  | { ok: false; code: "budget_exhausted" | "budget_revision_conflict" | "budget_request_conflict"; status: 409 | 429; state: TeamBudgetState };

function clone(state: TeamBudgetState): TeamBudgetState {
  return {
    tenantId: state.tenantId,
    revision: state.revision,
    limits: { ...state.limits },
    reserved: { ...state.reserved },
    settled: { ...state.settled },
  };
}

export class TeamBudgetLedger {
  private state: TeamBudgetState;
  private readonly byRequest = new Map<string, TeamBudgetReservation>();
  private readonly open = new Map<string, TeamBudgetReservation>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(tenantId: string, limits: TeamBudgetLimits) {
    if (!/^[A-Za-z0-9_-]{3,100}$/.test(tenantId)) throw new Error("team_budget_tenant_invalid");
    if (!Number.isSafeInteger(limits.requests) || limits.requests < 0 || !Number.isSafeInteger(limits.tokens) || limits.tokens < 0) {
      throw new Error("team_budget_limits_invalid");
    }
    this.state = {
      tenantId,
      revision: 1,
      limits: { ...limits },
      reserved: { requests: 0, tokens: 0 },
      settled: { requests: 0, tokens: 0 },
    };
  }

  snapshot(): TeamBudgetState {
    return clone(this.state);
  }

  private exclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.queue.then(() => fn());
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  available(): TeamBudgetLimits {
    return {
      requests: this.state.limits.requests - this.state.reserved.requests - this.state.settled.requests,
      tokens: this.state.limits.tokens - this.state.reserved.tokens - this.state.settled.tokens,
    };
  }

  async reserve(input: {
    requestId: string;
    principalId: string;
    requests: number;
    tokens: number;
    expectedRevision?: number;
  }): Promise<TeamBudgetDecision> {
    return this.exclusive(() => {
      if (!/^[A-Za-z0-9_-]{3,100}$/.test(input.requestId) || !/^[A-Za-z0-9_-]{3,100}$/.test(input.principalId)) {
        throw new Error("team_budget_input_invalid");
      }
      if (!Number.isSafeInteger(input.requests) || input.requests < 0 || !Number.isSafeInteger(input.tokens) || input.tokens < 0) {
        throw new Error("team_budget_amount_invalid");
      }
      const existing = this.byRequest.get(input.requestId);
      if (existing) {
        // Same requestId + same intent → idempotent replay; different body → conflict.
        if (existing.principalId !== input.principalId || existing.requests !== input.requests || existing.tokens !== input.tokens) {
          return { ok: false, code: "budget_request_conflict", status: 409, state: clone(this.state) };
        }
        return { ok: true, reservation: { ...existing }, state: clone(this.state) };
      }
      if (input.expectedRevision !== undefined && input.expectedRevision !== this.state.revision) {
        return { ok: false, code: "budget_revision_conflict", status: 409, state: clone(this.state) };
      }
      const avail = this.available();
      if (input.requests > avail.requests || input.tokens > avail.tokens) {
        return { ok: false, code: "budget_exhausted", status: 429, state: clone(this.state) };
      }
      const reservation: TeamBudgetReservation = {
        id: `tbr_${input.requestId}`,
        tenantId: this.state.tenantId,
        requestId: input.requestId,
        principalId: input.principalId,
        requests: input.requests,
        tokens: input.tokens,
        revisionAtReserve: this.state.revision,
      };
      this.state.reserved.requests += input.requests;
      this.state.reserved.tokens += input.tokens;
      this.state.revision += 1;
      this.byRequest.set(input.requestId, reservation);
      this.open.set(reservation.id, reservation);
      return { ok: true, reservation: { ...reservation }, state: clone(this.state) };
    });
  }

  async settle(reservationId: string, used: { requests: number; tokens: number }): Promise<TeamBudgetState> {
    return this.exclusive(() => {
      const reservation = this.open.get(reservationId);
      if (!reservation) return clone(this.state);
      if (!Number.isSafeInteger(used.requests) || used.requests < 0 || used.requests > reservation.requests) throw new Error("team_budget_settle_invalid");
      if (!Number.isSafeInteger(used.tokens) || used.tokens < 0 || used.tokens > reservation.tokens) throw new Error("team_budget_settle_invalid");
      this.state.reserved.requests -= reservation.requests;
      this.state.reserved.tokens -= reservation.tokens;
      this.state.settled.requests += used.requests;
      this.state.settled.tokens += used.tokens;
      this.state.revision += 1;
      this.open.delete(reservationId);
      return clone(this.state);
    });
  }

  /** Restart recovery: release open reservation without settling (no second charge). */
  async compensate(reservationId: string): Promise<TeamBudgetState> {
    return this.exclusive(() => {
      const reservation = this.open.get(reservationId);
      if (!reservation) return clone(this.state);
      this.state.reserved.requests -= reservation.requests;
      this.state.reserved.tokens -= reservation.tokens;
      this.state.revision += 1;
      this.open.delete(reservationId);
      this.byRequest.delete(reservation.requestId);
      return clone(this.state);
    });
  }
}
