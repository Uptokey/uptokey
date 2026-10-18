import { accountText, accountErrorText } from "./account-ui.ts";
import { getLang, type Lang } from "./i18n.ts";
import type { AccountView } from "./account.ts";

/** Closing a menu while its initial status read is pending must not start a later subscription read. */
export async function loadAccountPlanForView(account: { refresh(): Promise<void>; loadPlan(): Promise<void> }, signal: AbortSignal): Promise<void> {
  await account.refresh();
  if (!signal.aborted) await account.loadPlan();
}

/** Public subscription.status projection only; no checkout, price or private billing implementation. */
export interface AccountPlan {
  accountRef: string;
  subscription: { status: "none" | "active" | "past_due" | "paused" | "canceled"; cancelAtPeriodEnd: boolean; currentPeriodEnd: string | null };
  allowance: { limitMicros: number; usedMicros: number; reservedMicros: number; periodStart: string; periodEnd: string } | null;
}
export type AccountPlanState = { state: "unknown" | "loading" | "unavailable" } | { state: "observed"; value: AccountPlan };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("account_response_invalid");
  return value as Record<string, unknown>;
}
function instant(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function micros(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 1_000_000_000_000; }
export function readAccountPlan(value: unknown): AccountPlan {
  const row = object(value), subscription = object(row.subscription);
  if (typeof row.accountRef !== "string" || !/^account_[a-f0-9]{64}$/.test(row.accountRef) || typeof subscription.status !== "string" || !["none", "active", "past_due", "paused", "canceled"].includes(subscription.status) || typeof subscription.cancelAtPeriodEnd !== "boolean" || subscription.currentPeriodEnd !== null && !instant(subscription.currentPeriodEnd)) throw Error("account_response_invalid");
  let allowance: AccountPlan["allowance"] = null;
  if (row.allowance !== null) {
    const item = object(row.allowance);
    if (!micros(item.limitMicros) || !micros(item.usedMicros) || !micros(item.reservedMicros) || !instant(item.periodStart) || !instant(item.periodEnd) || Date.parse(item.periodStart) >= Date.parse(item.periodEnd)) throw Error("account_response_invalid");
    allowance = { limitMicros: item.limitMicros, usedMicros: item.usedMicros, reservedMicros: item.reservedMicros, periodStart: item.periodStart, periodEnd: item.periodEnd };
  }
  return { accountRef: row.accountRef, subscription: { status: subscription.status as AccountPlan["subscription"]["status"], cancelAtPeriodEnd: subscription.cancelAtPeriodEnd, currentPeriodEnd: subscription.currentPeriodEnd as string | null }, allowance };
}

/** Both renderers consume this summary; legacy profile.plan never establishes an entitlement. */
export function accountPlanPresentation(plan: AccountPlanState, lang: Lang = getLang(), now = Date.now()): { label: string; details: string[] } {
  if (plan.state !== "observed") return { label: accountText(plan.state === "loading" ? "plan_loading" : "plan_unavailable", {}, lang), details: [] };
  const { subscription, allowance } = plan.value;
  const plus = !["none", "canceled"].includes(subscription.status);
  let label = plus ? "Plus" : "Free";
  if (subscription.status === "past_due" || subscription.status === "paused" || subscription.status === "canceled") label += ` · ${accountText(subscription.status, {}, lang)}`;
  const details: string[] = [];
  if (!plus) details.push(accountText("free_hosted", {}, lang));
  const periodEnd = subscription.currentPeriodEnd;
  if (plus && periodEnd) details.push(accountText(subscription.cancelAtPeriodEnd ? "plan_ends" : "plan_period", { date: new Intl.DateTimeFormat(lang, { timeZone: "UTC" }).format(new Date(periodEnd)) }, lang));
  // A stale period or a non-active subscription cannot advertise spendable monthly allowance.
  if (subscription.status === "active" && allowance && Date.parse(allowance.periodStart) <= now && now < Date.parse(allowance.periodEnd) && periodEnd && now < Date.parse(periodEnd)) {
    const money = (amount: number) => new Intl.NumberFormat(lang, { style: "currency", currency: "USD" }).format(amount / 1_000_000);
    details.unshift(accountText("plan_allowance", { remaining: money(Math.max(0, allowance.limitMicros - allowance.usedMicros - allowance.reservedMicros)), limit: money(allowance.limitMicros) }, lang));
  }
  else if (subscription.status === "active") details.unshift(accountText("plus_hosted", {}, lang));
  return { label, details };
}

export function accountViewSummary(view: AccountView): string {
  if (view.challenge) return accountText("waiting", { code: view.challenge.userCode });
  if (view.login) return accountText("browser", { code: view.login.userCode });
  if (view.error) return accountErrorText(view.error);
  const session = view.session;
  if (!session) return accountText("loading");
  if (!session.configured) return accountText("unavailable");
  if (!session.authenticated) return accountText("signed_out");
  return `${session.profile?.displayName ?? session.profile?.email ?? accountText("connected")} · ${accountPlanPresentation(view.plan).label}`;
}
