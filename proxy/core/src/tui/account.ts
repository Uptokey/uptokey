/** Account UI state only. Credentials, account grants and identity remain with the canonical core. */
import { EventEmitter } from "node:events";
import { spawn, type SpawnOptions } from "node:child_process";
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

export const ACCOUNT_POLL_INTERVAL_MS = 4_000;
type AccountBrowserOpener = (url: string) => boolean | Promise<boolean>;
type BrowserLaunch = (command: string, args: string[], options: SpawnOptions) => ReturnType<typeof spawn>;

/** Only core-generated authorization URLs are opened; model text and arbitrary shell commands never reach this. */
export async function openAccountLoginUrl(value: string, launch: BrowserLaunch = spawn, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  let target: URL;
  try { target = new URL(value); } catch { return false; }
  if (target.username || target.password || target.hash || target.pathname !== "/api/account/native/authorize" || [...target.searchParams.keys()].length !== 1 || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(target.searchParams.get("id") ?? "") || target.protocol !== "https:" && !(target.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname))) return false;
  const [command, args] = platform === "win32"
    ? ["rundll32", ["url.dll,FileProtocolHandler", target.href]]
    : platform === "darwin" ? ["open", [target.href]] : ["xdg-open", [target.href]];
  try {
    const child = launch(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    const result = new Promise<boolean>(resolve => {
      // A successful spawn alone says nothing about `open`/`xdg-open` accepting
      // the URL. Keep the fallback link when the command fails or never settles.
      const timer = setTimeout(() => resolve(false), 5_000);
      timer.unref?.();
      const settle = (opened: boolean) => { clearTimeout(timer); resolve(opened); };
      child.once("error", () => settle(false));
      child.once("exit", code => settle(code === 0));
    });
    const opened = await result;
    child.unref();
    return opened;
  } catch { return false; }
}

export class TuiAccount extends EventEmitter {
  readonly view: AccountView = { session: null, available: null, requests: [], challenge: null, login: null, usage: null, plan: { state: "unknown" }, busy: false, error: null };
  private generation = 0;
  private disposed = false;
  private abort: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private refreshing: Promise<void> | null = null;
  private usageRead: Promise<void> | null = null;
  private usageGeneration = 0;
  private active: Promise<void> | null = null;
  private activeKind: "read" | "mutation" | null = null;
  private retryAt = 0;
  private planAbort: AbortController | null = null;
  private planRead: Promise<void> | null = null;
  private planBinding: string | null = null;
  private planRequested = false;
  private readonly now: () => number;
  private readonly interval: number;
  private readonly client: AccountTransport;
  constructor(client: AccountTransport, options: { now?: () => number; intervalMs?: number } = {}) {
    super(); this.client = client; this.now = options.now ?? Date.now; this.interval = options.intervalMs ?? ACCOUNT_POLL_INTERVAL_MS;
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
  private begin(kind: "read" | "mutation") {
    if (this.disposed || this.view.busy && (kind === "read" || this.activeKind !== "read")) return null;
    if (this.view.busy && this.activeKind === "read") this.refreshing = null;
    this.abort?.abort(); clearTimeout(this.timer);
    const abort = new AbortController(), generation = ++this.generation;
    this.abort = abort; this.activeKind = kind; this.view.busy = true; this.view.error = null; this.change();
    return { signal: abort.signal, current: () => !this.disposed && generation === this.generation && !abort.signal.aborted };
  }
  private perform(action: (signal: AbortSignal) => Promise<void>, kind: "read" | "mutation" = "mutation"): Promise<void> {
    const operation = this.begin(kind); if (!operation) return this.active ?? Promise.resolve();
    const promise = (async () => {
      try { await action(operation.signal); if (operation.current()) this.retryAt = 0; }
      catch (error) { if (operation.current()) {
        this.view.error = this.error(error);
        const status = Number((error as { status?: unknown })?.status);
        if (status === 401 || status === 403 || /^account_(?:challenge_expired|session_expired|session_revoked|reauthentication_required|share_denied)$/.test(this.view.error)) {
          this.view.login = null; this.view.challenge = null;
          this.view.session = null; this.view.available = null; this.view.usage = null; this.clearPlan();
        }
        if (this.view.error === "account_rate_limited") this.retryAt = this.now() + Math.max(this.interval, Number((error as { retryAfterMs?: number }).retryAfterMs) || 10_000);
      } }
      finally { if (operation.current()) { this.active = null; this.activeKind = null; this.view.busy = false; this.change(); this.schedule(); } }
    })();
    this.active = promise;
    return promise;
  }
  private async read(signal: AbortSignal): Promise<void> {
    let session: AccountPublicSession;
    try { session = await this.client.getAccountSession(signal); }
    catch (error) {
      // Pending challenges may be reported as HTTP 409 while the browser waits
      // for approval. That response is not a failed account service.
      if (this.view.login && this.error(error) === "account_challenge_pending") return;
      throw error;
    }
    if (signal.aborted || this.disposed) return;
    // A verified loss of authority takes effect even when the following
    // optional account projection is temporarily unavailable.
    if (!session.authenticated) {
      this.view.session = session; this.view.available = null; this.view.requests = []; this.view.usage = null; this.clearPlan();
      if (this.view.login && session.state === "signed_out") {
        this.view.login = null;
        throw new Error("account_reauthentication_required");
      }
    }
    const available = await this.client.getAvailableAccounts(signal);
    if (signal.aborted || this.disposed) return;
    const requests = available.currentOwned ? await this.client.getAccountRequests(signal) : [];
    if (!signal.aborted && !this.disposed) {
      // Status alone is not a usable account. Keep the existing challenge while
      // a transient projection failure is retried, and publish one coherent view.
      this.view.session = session; this.view.available = available;
      this.view.usage = session.authenticated ? this.view.usage : null;
      if (!session.authenticated) this.clearPlan();
      if (this.planBinding && this.binding() !== this.planBinding) { this.clearPlan(); this.view.usage = null; }
      this.view.requests = requests;
      if (session.authenticated) { this.view.challenge = null; this.view.login = null; }
      if (this.planRequested && session.authenticated) void this.loadPlan();
    }
  }
  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const generation = this.generation;
    const promise = this.activeKind === "mutation" && this.active
      ? this.active.then(() => { if (!this.disposed && this.generation === generation) return this.perform(signal => this.read(signal), "read"); })
      : this.perform(signal => this.read(signal), "read");
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
  login(open: AccountBrowserOpener = openAccountLoginUrl): Promise<void> {
    return this.perform(async signal => {
      const result = await this.client.startAccountLogin(signal);
      if (signal.aborted || this.disposed) return;
      this.view.challenge = null;
      if ("session" in result) { this.view.session = result.session; this.view.login = null; await this.read(signal); }
      else {
        this.view.login = result;
        let opened = false;
        try { opened = await open(result.loginUrl); } catch { /* Keep the full login URL as the recovery path. */ }
        if (!signal.aborted && !this.disposed && this.view.login === result && !opened) this.view.error = "account_browser_unavailable";
      }
    });
  }
  /** Reopening the existing challenge never creates or replaces a device login. */
  async reopenLogin(open: AccountBrowserOpener = openAccountLoginUrl): Promise<void> {
    const login = this.view.login;
    if (this.disposed || !login) return;
    if (login.expiresAt <= this.now()) {
      this.cancelPending();
      this.view.error = "account_challenge_expired";
      this.change();
      return;
    }
    let opened = false;
    try { opened = await open(login.loginUrl); } catch { /* Opening the browser must not discard a pending challenge. */ }
    if (!this.disposed && this.view.login === login) {
      this.view.error = opened ? null : "account_browser_unavailable";
      this.change();
    }
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
    if (this.usageRead) return this.usageRead;
    const binding = this.binding(), generation = this.usageGeneration;
    const current = () => !this.disposed && generation === this.usageGeneration && this.binding() === binding;
    const promise = (async () => {
      // An explicit credit read must survive an in-flight Refresh. The shared
      // read gate otherwise returns that operation without sending this one.
      while (this.active) {
        await this.active;
        if (!current()) return;
      }
      if (!binding || !current()) return;
      void this.loadPlan();
      await this.perform(async signal => {
        const result = await this.client.getAccountUsage(signal);
        if (!signal.aborted && current()) this.view.usage = result;
      }, "read");
    })();
    this.usageRead = promise;
    void promise.finally(() => { if (this.usageRead === promise) this.usageRead = null; });
    return promise;
  }
  cancelPending(): void {
    this.planRequested = false;
    this.clearPlan();
    ++this.generation; this.abort?.abort(); clearTimeout(this.timer);
    ++this.usageGeneration; this.usageRead = null;
    this.refreshing = null; this.active = null; this.activeKind = null; this.retryAt = 0;
    this.view.challenge = null; this.view.login = null; this.view.busy = false; this.view.error = null; this.change();
  }
  cancelPlanRead(): void { this.planRequested = false; if (this.planRead) { this.clearPlan(); this.change(); } }
  private schedule(): void {
    clearTimeout(this.timer);
    if (this.disposed || this.view.busy || !this.view.challenge && !this.view.login) return;
    const expiresAt = this.view.challenge ? Date.parse(this.view.challenge.expiresAt) : this.view.login!.expiresAt;
    if (expiresAt <= this.now()) { this.view.challenge = null; this.view.login = null; this.view.error = "account_challenge_expired"; this.change(); return; }
    this.timer = setTimeout(() => void this.poll(), Math.min(Math.max(this.interval, this.retryAt - this.now()), expiresAt - this.now()));
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
    }, this.view.challenge ? "mutation" : "read");
  }
  dispose(): void { this.disposed = true; this.clearPlan(); ++this.generation; ++this.usageGeneration; this.usageRead = null; this.abort?.abort(); clearTimeout(this.timer); this.removeAllListeners(); }
}
