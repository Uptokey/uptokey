/** Account UI state only. Credentials, account grants and identity remain with the canonical core. */
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import type { AccountPublicSession, AccountPublicUsage } from "../account-login-protocol.ts";
import type { TuiClient, TuiAccountAvailable, TuiAccountChallenge, TuiAccountLogin, TuiAccountRequest } from "./client.ts";
import type { AccountPlanState } from "./account-plan.ts";

type AccountTransport = Pick<TuiClient, "getAccountSession" | "getAvailableAccounts" | "getAccountRequests" | "requestAccountAccess" | "consumeAccountAccess" | "approveAccountRequest" | "adoptAccount" | "unlinkAccount" | "startAccountLogin" | "signOutAccount" | "getAccountUsage"> & Partial<Pick<TuiClient, "getAccountPlan">>;
export interface AccountView {
  session: AccountPublicSession | null;
  available: TuiAccountAvailable | null;
  requests: TuiAccountRequest[];
  challenge: TuiAccountChallenge | null;
  login: Exclude<TuiAccountLogin, { session: AccountPublicSession }> | null;
  usage: AccountPublicUsage | null;
  plan: AccountPlanState;
  busy: boolean;
  error: string | null;
}

/** Only core-generated authorization URLs are opened; model text and arbitrary shell commands never reach this. */
export function openAccountLoginUrl(value: string): boolean {
  let target: URL;
  try { target = new URL(value); } catch { return false; }
  if (target.username || target.password || target.hash || target.pathname !== "/api/account/native/authorize" || [...target.searchParams.keys()].length !== 1 || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(target.searchParams.get("id") ?? "") || target.protocol !== "https:" && !(target.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname))) return false;
  const [command, args] = process.platform === "win32"
    ? ["rundll32", ["url.dll,FileProtocolHandler", target.href]]
    : process.platform === "darwin" ? ["open", [target.href]] : ["xdg-open", [target.href]];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => undefined);
    child.unref();
    return true;
  } catch { return false; }
}

export class TuiAccount extends EventEmitter {
  readonly view: AccountView = { session: null, available: null, requests: [], challenge: null, login: null, usage: null, plan: { state: "unknown" }, busy: false, error: null };
  private generation = 0;
  private disposed = false;
  private abort: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private refreshing: Promise<void> | null = null;
  private planAbort: AbortController | null = null;
  private planRead: Promise<void> | null = null;
  private planBinding: string | null = null;
  private planRequested = false;
  private readonly now: () => number;
  private readonly interval: number;
  private readonly client: AccountTransport;
  constructor(client: AccountTransport, options: { now?: () => number; intervalMs?: number } = {}) {
    super(); this.client = client; this.now = options.now ?? Date.now; this.interval = options.intervalMs ?? 2500;
  }
  private change() { if (!this.disposed) this.emit("change"); }
  private binding(available = this.view.available): string | null {
    return this.view.session?.authenticated && available?.currentAccountRef ? `${available.currentAccountRef}:${available.revision}` : null;
  }
  private clearPlan(): void {
    this.planAbort?.abort(); this.planAbort = null; this.planRead = null; this.planBinding = null;
    this.view.plan = { state: "unknown" };
  }
  private error(error: unknown) {
    const code = error instanceof Error ? error.message : "";
    return /^account_[a-z_]{1,80}$/.test(code) ? code : "account_service_unavailable";
  }
  private begin() {
    if (this.disposed || this.view.busy) return null;
    this.abort?.abort(); clearTimeout(this.timer);
    const abort = new AbortController(), generation = ++this.generation;
    this.abort = abort; this.view.busy = true; this.view.error = null; this.change();
    return { signal: abort.signal, current: () => !this.disposed && generation === this.generation && !abort.signal.aborted };
  }
  private async perform(action: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const operation = this.begin(); if (!operation) return;
    try { await action(operation.signal); }
    catch (error) { if (operation.current()) this.view.error = this.error(error); }
    finally { if (operation.current()) { this.view.busy = false; this.change(); this.schedule(); } }
  }
  private async read(signal: AbortSignal): Promise<void> {
    const session = await this.client.getAccountSession(signal);
    if (signal.aborted || this.disposed) return;
    this.view.session = session;
    this.view.usage = session.authenticated ? this.view.usage : null;
    if (!session.authenticated) this.clearPlan();
    if (session.authenticated) { this.view.challenge = null; this.view.login = null; }
    const available = await this.client.getAvailableAccounts(signal);
    if (signal.aborted || this.disposed) return;
    this.view.available = available;
    if (this.planBinding && this.binding() !== this.planBinding) { this.clearPlan(); this.view.usage = null; }
    const requests = available.currentOwned ? await this.client.getAccountRequests(signal) : [];
    if (!signal.aborted && !this.disposed) {
      this.view.requests = requests;
      if (this.planRequested && session.authenticated) void this.loadPlan();
    }
  }
  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const promise = this.perform(signal => this.read(signal));
    this.refreshing = promise;
    void promise.finally(() => { if (this.refreshing === promise) this.refreshing = null; });
    return promise;
  }
  /** Only account UI/usage asks for this bounded read; startup and model selection never wait on it. */
  loadPlan(): Promise<void> {
    this.planRequested = true;
    if (this.planRead) return this.planRead;
    const binding = this.binding();
    if (this.disposed || !binding) return Promise.resolve();
    if (!this.client.getAccountPlan) { this.view.plan = { state: "unavailable" }; this.change(); return Promise.resolve(); }
    const abort = new AbortController(); this.planAbort = abort; this.planBinding = binding;
    const current = () => !this.disposed && !abort.signal.aborted && this.planAbort === abort && this.binding() === binding;
    this.view.plan = { state: "loading" }; this.change();
    const promise = (async () => {
      try {
        const before = await this.client.getAvailableAccounts(abort.signal);
        if (!current()) return;
        if (this.binding(before) !== binding) { this.clearPlan(); this.change(); return; }
        const value = await this.client.getAccountPlan!(abort.signal);
        if (!current()) return;
        const after = await this.client.getAvailableAccounts(abort.signal);
        if (!current()) return;
        if (this.binding(after) !== binding) { this.clearPlan(); this.change(); return; }
        this.view.plan = { state: "observed", value };
      } catch { if (current()) this.view.plan = { state: "unavailable" }; }
      finally { if (current()) { this.planRead = null; this.change(); } }
    })();
    this.planRead = promise;
    return promise;
  }
  requestAccess(): Promise<void> {
    return this.perform(async signal => {
      const challenge = await this.client.requestAccountAccess(signal);
      if (signal.aborted || this.disposed) return;
      this.view.challenge = challenge; this.view.login = null;
    });
  }
  adopt(accountRef: string): Promise<void> {
    return this.perform(async signal => {
      this.clearPlan();
      const revision = this.view.available?.revision;
      if (revision === undefined) throw new Error("account_share_conflict");
      const result = await this.client.adoptAccount(accountRef, revision, signal);
      if (signal.aborted || this.disposed) return;
      this.view.session = result.session; this.view.challenge = null; this.view.login = null; this.view.usage = null;
      await this.read(signal);
    });
  }
  approve(request: TuiAccountRequest, accountRef: string): Promise<void> {
    return this.perform(async signal => { await this.client.approveAccountRequest(request.id, request.userCode, accountRef, signal); if (!signal.aborted) await this.read(signal); });
  }
  login(open: (url: string) => boolean = openAccountLoginUrl): Promise<void> {
    return this.perform(async signal => {
      const result = await this.client.startAccountLogin(signal);
      if (signal.aborted || this.disposed) return;
      this.view.challenge = null;
      if ("session" in result) { this.view.session = result.session; this.view.login = null; await this.read(signal); }
      else { this.view.login = result; if (!open(result.loginUrl)) this.view.error = "account_browser_unavailable"; }
    });
  }
  disconnect(): Promise<void> {
    return this.perform(async signal => {
      this.clearPlan();
      const revision = this.view.available?.revision;
      if (revision === undefined) throw new Error("account_share_conflict");
      const result = await this.client.unlinkAccount(revision, signal);
      if (signal.aborted || this.disposed) return;
      this.view.session = result.session; this.view.usage = null; await this.read(signal);
    });
  }
  logout(): Promise<void> {
    return this.perform(async signal => {
      this.clearPlan();
      const result = await this.client.signOutAccount(signal);
      if (signal.aborted || this.disposed) return;
      this.view.session = result; this.view.usage = null; await this.read(signal);
    });
  }
  loadUsage(): Promise<void> {
    void this.loadPlan();
    return this.perform(async signal => { const result = await this.client.getAccountUsage(signal); if (!signal.aborted && !this.disposed) this.view.usage = result; });
  }
  cancelPending(): void {
    this.planRequested = false;
    this.clearPlan();
    ++this.generation; this.abort?.abort(); clearTimeout(this.timer);
    this.view.challenge = null; this.view.login = null; this.view.busy = false; this.view.error = null; this.change();
  }
  cancelPlanRead(): void { this.planRequested = false; if (this.planRead) { this.clearPlan(); this.change(); } }
  private schedule(): void {
    clearTimeout(this.timer);
    if (this.disposed || this.view.busy || !this.view.challenge && !this.view.login) return;
    const expiresAt = this.view.challenge ? Date.parse(this.view.challenge.expiresAt) : this.view.login!.expiresAt;
    if (expiresAt <= this.now()) { this.view.challenge = null; this.view.login = null; this.view.error = "account_challenge_expired"; this.change(); return; }
    this.timer = setTimeout(() => void this.poll(), Math.min(this.interval, expiresAt - this.now()));
    this.timer.unref?.();
  }
  private poll(): Promise<void> {
    return this.perform(async signal => {
      const challenge = this.view.challenge, login = this.view.login;
      if (!challenge && !login) return;
      if ((challenge ? Date.parse(challenge.expiresAt) : login!.expiresAt) <= this.now()) { this.view.challenge = null; this.view.login = null; throw new Error("account_challenge_expired"); }
      if (!challenge) { await this.read(signal); return; }
      try { await this.client.consumeAccountAccess(challenge.id, signal); }
      catch (error) { if (signal.aborted || this.disposed) return; if (this.error(error) === "account_share_pending") return; this.view.challenge = null; throw error; }
      if (signal.aborted || this.disposed) return;
      this.view.challenge = null;
      await this.read(signal);
      const available = this.view.available;
      if (!signal.aborted && available?.accounts.length === 1 && !this.view.session?.authenticated) {
        const result = await this.client.adoptAccount(available.accounts[0]!.accountRef, available.revision, signal);
        if (!signal.aborted && !this.disposed) { this.view.session = result.session; await this.read(signal); }
      }
    });
  }
  dispose(): void { this.disposed = true; this.clearPlan(); ++this.generation; this.abort?.abort(); clearTimeout(this.timer); this.removeAllListeners(); }
}
