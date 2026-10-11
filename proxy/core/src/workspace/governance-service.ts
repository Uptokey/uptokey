import { GovernanceStore } from "./governance-store.ts";
import type { Workspace, WorkspacePolicy, WorkspaceBudget, PolicyDecision } from "./governance-types.ts";
import type {ExecutionPlan,CapabilityDescriptor,ExecutionReceipt,UsageValueReceipt,Run} from '@uptokey/sync-contract/workflow';
import {parseGatewayWireRequest} from '@uptokey/sync-contract/gateway';
import {conservativeTokenEstimate,reservationTokenEstimate} from '../token-estimate.ts';
import {UsageValueEngine} from './usage-value.ts';
import {createHash} from 'node:crypto';
import { randomUUID } from "node:crypto";
import type { DispatchBudgetAttempt, DispatchBudgetReservation } from '../types.ts';
import type { AccountFundingObservationInput } from '@uptokey/sync-contract/connections';

export interface ConversationBudgetScope { id: string; temporary: boolean }
export interface ConversationBudgetView { limitMicros: number | null; revision: number; reservedMicros: string; settledMicros: string }

/**
 * WorkspacePolicyService — proposta E2-07. Dono único por workspace/governança.
 * Autenticado pelo principal canônico. Não recebe BYOK/prompts/conversas.
 */
export class WorkspacePolicyService {
  store: GovernanceStore;
  now: () => Date;
  private readonly temporaryStore: GovernanceStore;
  constructor(store: GovernanceStore, now: () => Date = () => new Date()) {
    this.store = store;
    this.now = now;
    this.temporaryStore = new GovernanceStore(store.secrets, store.root, now, { ephemeral: true });
  }

  async close(): Promise<void> { await this.temporaryStore.close(); }

  getAccountFunding(providerId: string, accountId: string) {
    return this.store.getAccountFunding(providerId, accountId);
  }

  putAccountFunding(providerId: string, accountId: string, input: AccountFundingObservationInput) {
    return this.store.putAccountFunding(providerId, accountId, input);
  }

  /** Auxiliary/workflow inference already owns its task budgets. Charge only the
   * same commercial account here; requestId must be server-owned and unique. */
  async reserveAccountFunding(requestId: string, attempt: Omit<DispatchBudgetAttempt, 'provider'> & {provider: string}): Promise<DispatchBudgetReservation | undefined> {
    if (!attempt.commercialAccount) return;
    const account = { ...attempt.commercialAccount };
    if (account.providerId !== attempt.provider) throw new Error('account_funding_identity_invalid');
    if (typeof attempt.costMicros !== 'string' || !/^(0|[1-9][0-9]{0,29})$/.test(attempt.costMicros)) throw new Error('budget_cost_unknown');
    const amount = attempt.costMicros;
    const priceUsage = attempt.priceUsage;
    const key = 'funding_' + createHash('sha256').update(JSON.stringify([requestId, attempt.id])).digest('hex');
    const result = await this.store.reserveAccountFunding(account.providerId, account.accountId, { requestId: key, amountMicros: amount });
    if (!result.ok || !result.windowKey) throw new Error(result.code ?? 'budget_exceeded');
    const reservation = { budgetId: result.budgetId, windowKey: result.windowKey, requestId: key };
    let open = true;
    let queue = Promise.resolve();
    const finish = (operation: () => Promise<void>) => { const next = queue.then(operation); queue = next.catch(() => {}); return next; };
    return {
      validate: () => this.store.validateAccountFunding(account.providerId, account.accountId, result.observationRevision),
      compensate: () => finish(async () => {
        if (!open) return;
        await this.store.compensateBudget(result.principalId, result.workspaceId, reservation); open = false;
      }),
      settle: (input, output) => finish(async () => {
        if (!open || !Number.isSafeInteger(input) || !Number.isSafeInteger(output) || input! < 0 || output! < 0) return;
        const used = priceUsage(input!, output!);
        if (used === null || !/^(0|[1-9][0-9]{0,29})$/.test(used) || BigInt(used) > BigInt(amount)) return;
        await this.store.settleBudget(result.principalId, result.workspaceId, { ...reservation, usedMicros: used }); open = false;
      }),
      settleCost: used => finish(async () => {
        if (!open) return;
        if (typeof used !== 'string' || !/^(0|[1-9][0-9]{0,29})$/.test(used) || BigInt(used) > BigInt(amount)) throw new Error('budget_usage_invalid');
        await this.store.settleBudget(result.principalId, result.workspaceId, { ...reservation, usedMicros: used }); open = false;
      }),
    };
  }

  private conversationStore(scope: ConversationBudgetScope): GovernanceStore { return scope.temporary ? this.temporaryStore : this.store; }
  private conversationBudgetId(id: string): string { return 'conversation_' + createHash('sha256').update(id).digest('hex'); }

  async getConversationBudget(principal: string, scope: ConversationBudgetScope): Promise<ConversationBudgetView> {
    const store = this.conversationStore(scope), ws = await store.findPersonalWorkspace(principal);
    const budget = ws ? (await store.listBudgets(principal, ws.id)).find(b => b.id === this.conversationBudgetId(scope.id)) : undefined;
    const usage = budget && ws ? (await store.listBudgetUsage(principal, ws.id)).find(u => u.budgetId === budget.id && u.windowKey === 'total') : undefined;
    const [whole='0',fraction=''] = budget?.amount.split('.') ?? [];
    return { limitMicros: budget && budget.enabled !== false ? Number(BigInt(whole)*1_000_000n+BigInt(fraction.padEnd(6,'0'))) : null,
      revision: budget?.revision ?? 0, reservedMicros: usage?.reserved ?? '0', settledMicros: usage?.settled ?? '0' };
  }

  async setConversationBudget(principal: string, scope: ConversationBudgetScope, limitMicros: number | null, expectedRevision: number, revalidate: () => Promise<void>): Promise<ConversationBudgetView> {
    if (limitMicros !== null && (!Number.isSafeInteger(limitMicros) || limitMicros < 0 || limitMicros > 1_000_000_000)) throw new Error('budget_amount_invalid');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('budget_revision_conflict');
    await revalidate();
    const store = this.conversationStore(scope), ws = await store.ensurePersonalWorkspace(principal);
    const amount = BigInt(limitMicros ?? 0);
    await revalidate();
    await store.putBudget(principal, ws.id, { id: this.conversationBudgetId(scope.id), workspaceId: ws.id, scope: 'conversation', subjectId: scope.id,
      enabled: limitMicros !== null, unit: 'money', currency: 'USD', amount: `${amount / 1_000_000n}.${(amount % 1_000_000n).toString().padStart(6, '0')}`,
      period: 'total', timezone: 'UTC', includeByokUsage: true, expectedRevision },revalidate);
    return this.getConversationBudget(principal, scope);
  }

  private async conversationBudgetSource(principal: string, scope?: ConversationBudgetScope) {
    if (!scope) return undefined;
    const store = this.conversationStore(scope), ws = await store.findPersonalWorkspace(principal);
    if (!ws) return undefined;
    const budgets = (await store.listBudgets(principal, ws.id)).filter(b => b.scope === 'conversation' && b.subjectId === scope.id && b.enabled !== false);
    return { store, ws, budgets };
  }

  async forgetTemporaryConversationBudget(principal: string, conversationId: string): Promise<void> {
    await this.temporaryStore.forgetTemporaryBudget(principal,this.conversationBudgetId(conversationId));
  }

  /** Existing execution reservations may span a team workspace and a personal task.
   * Both use GovernanceStore's ledger; temporary task identifiers never enter disk. */
  private async executionSources(principal: string, projectId: string) {
    const primary = await this.executionWorkspace(principal, projectId);
    const sources = [{ store: this.store, ws: primary }];
    const personal = await this.store.findPersonalWorkspace(principal);
    if (personal && personal.id !== primary.id) sources.push({ store: this.store, ws: personal });
    const temporary = await this.temporaryStore.findPersonalWorkspace(principal);
    if (temporary) sources.push({ store: this.temporaryStore, ws: temporary });
    return sources;
  }

  async ensurePersonal(principalId: string): Promise<Workspace> {
    return this.store.ensurePersonalWorkspace(principalId);
  }

  async createWorkspace(principalId: string, input: { name: string; description?: string; idempotencyKey?: string }): Promise<Workspace> {
    return this.store.createWorkspace(principalId, input);
  }

  async listWorkspaces(principalId: string, after?: string, limit?: number) {
    return this.store.listWorkspaces(principalId, after ?? "", limit ?? 100);
  }

  async getWorkspace(principalId: string, workspaceId: string): Promise<Workspace> {
    return this.store.getWorkspace(principalId, workspaceId);
  }

  async deleteWorkspace(principalId: string, workspaceId: string, expectedRevision: number): Promise<void> {
    return this.store.deleteWorkspace(principalId, workspaceId, expectedRevision);
  }

  async updateWorkspace(principalId: string, workspaceId: string, input: { name?: string; description?: string; expectedRevision: number }): Promise<Workspace> {
    return this.store.updateWorkspace(principalId, workspaceId, input);
  }

  async archiveWorkspace(principalId: string, workspaceId: string, expectedRevision: number): Promise<Workspace> {
    return this.store.archiveWorkspace(principalId, workspaceId, expectedRevision);
  }

  async overview(principalId: string, workspaceId: string) {
    return this.store.overview(principalId, workspaceId);
  }

  async invite(principalId: string, workspaceId: string, input: { email: string; role: "admin" | "member" | "viewer"; requestId: string }) {
    return this.store.inviteMember(principalId, workspaceId, input);
  }

  async accept(principalId: string, input: { email: string; inviteToken: string }) {
    return this.store.acceptInvite(principalId, input);
  }

  async listMembers(principalId: string, workspaceId: string) {
    return this.store.listMembers(principalId, workspaceId);
  }

  async revoke(principalId: string, workspaceId: string, memberId: string, expectedRevision: number) {
    return this.store.revokeMember(principalId, workspaceId, memberId, expectedRevision);
  }

  async updateRole(principalId: string, workspaceId: string, memberId: string, role: "owner" | "admin" | "member" | "viewer", expectedRevision: number) {
    return this.store.updateMemberRole(principalId, workspaceId, memberId, { role: role as import("./governance-types.ts").WorkspaceRole, expectedRevision });
  }

  async putPolicy(principalId: string, workspaceId: string, policy: Omit<WorkspacePolicy, "revision" | "createdAt" | "updatedAt"> & { expectedRevision?: number }) {
    return this.store.putPolicy(principalId, workspaceId, policy);
  }

  async getPolicies(principalId: string, workspaceId: string) {
    return this.store.getPolicies(principalId, workspaceId);
  }

  async getEffectivePolicy(principalId: string, workspaceId: string, subject: { memberId?: string; keyId?: string; projectId?: string }) {
    return this.store.getEffectivePolicy(principalId, workspaceId, subject);
  }

  async putBudget(principalId: string, workspaceId: string, budget: Omit<WorkspaceBudget, "revision" | "createdAt" | "updatedAt"> & { expectedRevision?: number }) {
    return this.store.putBudget(principalId, workspaceId, budget);
  }

  async listBudgets(principalId: string, workspaceId: string) {
    return this.store.listBudgets(principalId, workspaceId);
  }

  async migrate(principalId: string, projectIds: string[]) {
    return this.store.migrateLegacyProjects(principalId, projectIds);
  }

  async reserveBudget(principalId: string, workspaceId: string, input: { budgetId: string; requestId: string; amountMicros: string; expectedRevision?: number }) {
    return this.store.reserveBudget(principalId, workspaceId, input);
  }

  async settleBudget(principalId: string, workspaceId: string, input: { budgetId: string; windowKey: string; requestId: string; usedMicros: string }) {
    return this.store.settleBudget(principalId, workspaceId, input);
  }

  async compensateBudget(principalId: string, workspaceId: string, input: { budgetId: string; windowKey: string; requestId: string }) {
    return this.store.compensateBudget(principalId, workspaceId, input);
  }

  async evaluateDecision(input: { principalId: string; workspaceId: string; model?: string; provider?: string; tool?: string; keyId?: string; projectId?: string }): Promise<PolicyDecision> {
    // Single evaluation source: the store's effective policy (deny-wins,
    // allowlist intersection, archived-blocks-runs). No duplicated logic here.
    const effective = await this.store.getEffectivePolicy(input.principalId, input.workspaceId, {
      memberId: input.principalId,
      keyId: input.keyId,
      projectId: input.projectId,
      model: input.model,
      provider: input.provider,
      tool: input.tool,
    });
    return {
      allowed: effective.allowed,
      reasonCodes: effective.reasonCodes,
      policyVersions: effective.policyVersions,
      limitsSnapshot: effective.limitsSnapshot as Record<string, unknown> | null,
      admissionId: randomUUID(),
    };
  }

  async executionWorkspace(principalId:string,projectId:string){
    const mapped=await this.store.getProjectWorkspace(projectId);
    return mapped?this.getWorkspace(principalId,mapped):this.ensurePersonal(principalId);
  }

  /** Direct chat and auxiliary inference use the SAME durable budgets as workflows.
   * Only numeric usage/opaque IDs enter the store; no workspace is created for a read.
   * Unknown or cancelled upstream outcomes keep the reservation across restarts. */
  async reserveInferenceBudgets(principalId: string, projectId: string | undefined, requestId: string, attempt: DispatchBudgetAttempt, keyId?: string, conversation?: ConversationBudgetScope): Promise<DispatchBudgetReservation | undefined> {
    const account = attempt.commercialAccount ? { ...attempt.commercialAccount } : undefined;
    if (account && account.providerId !== attempt.provider) throw new Error('account_funding_identity_invalid');
    const mapped = projectId ? await this.store.getProjectWorkspace(projectId) : null;
    const ws = mapped ? await this.getWorkspace(principalId, mapped) : await this.store.findPersonalWorkspace(principalId);
    const now = this.now().toISOString();
    const shared = ws ? (await this.listBudgets(principalId, ws.id)).filter(b => b.enabled !== false &&
      (b.scope === 'workspace' || b.scope === 'member' && b.subjectId === principalId || b.scope === 'project' && b.subjectId === projectId || b.scope === 'key' && b.subjectId === keyId) &&
      (!b.startsAt || b.startsAt <= now) && (!b.endsAt || b.endsAt > now)).map(budget => ({ budget, store: this.store, workspaceId: ws.id })) : [];
    const task = await this.conversationBudgetSource(principalId, conversation);
    const budgets = [...shared, ...(task?.budgets.map(budget => ({ budget, store: task.store, workspaceId: task.ws.id })) ?? [])];
    if (!budgets.length && !account) return;
    const amountFor = (b: WorkspaceBudget, input: number, output: number, observed: boolean): string | null => {
      if (b.unit === 'request') return '1';
      if (b.unit === 'token') return (BigInt(input) + BigInt(output)).toString();
      if (b.currency !== 'USD') return null;
      if (attempt.accessMode === 'local' || !b.includeByokUsage) return '0';
      return observed ? attempt.priceUsage(input, output) : attempt.costMicros;
    };
    const amounts = budgets.map(entry => ({ ...entry, amount: amountFor(entry.budget, attempt.inputTokens, attempt.outputTokens, false) }));
    if (amounts.some(a => a.amount === null) || account && (typeof attempt.costMicros !== 'string'
      || !/^(0|[1-9][0-9]{0,29})$/.test(attempt.costMicros))) throw new Error('budget_cost_unknown');
    const key = executionBudgetKey(projectId ?? 'direct', requestId + ':' + attempt.id);
    const acquired: Array<{ store: GovernanceStore; principalId: string; workspaceId: string; budget: WorkspaceBudget; budgetId: string; windowKey: string; requestId: string; amount: string }> = [];
    let funding: DispatchBudgetReservation | undefined;
    try {
      for (const { budget, amount, store, workspaceId } of amounts) {
        const result = await store.reserveBudget(principalId, workspaceId, { budgetId: budget.id, requestId: key, amountMicros: amount! });
        if (!result.ok || !result.windowKey) throw new Error(result.code ?? 'budget_exceeded');
        acquired.push({ store, principalId, workspaceId, budget, budgetId: budget.id, windowKey: result.windowKey, requestId: key, amount: amount! });
      }
      if (account) {
        // The internal ledger principal is shared, but callers' idempotency keys
        // are not: identical request IDs from different principals debit twice.
        funding = await this.reserveAccountFunding(JSON.stringify(['inference', principalId, projectId ?? null, requestId]), attempt);
      }
    } catch (error) {
      for (const entry of acquired) await entry.store.compensateBudget(entry.principalId, entry.workspaceId, entry);
      throw error;
    }
    // Serialize completion callbacks; retain entries when a durable write fails.
    let queue = Promise.resolve();
    const finish = (operation: () => Promise<void>) => { const next = queue.then(operation); queue = next.catch(() => {}); return next; };
    return {
      ...(funding?.validate ? { validate: funding.validate } : {}),
      compensate: () => finish(async () => {
        while (acquired.length) { const entry = acquired[0]!; await entry.store.compensateBudget(entry.principalId, entry.workspaceId, entry); acquired.shift(); }
        await funding?.compensate();
      }),
      settle: (input, output) => finish(async () => {
        if (!Number.isSafeInteger(input) || !Number.isSafeInteger(output) || input! < 0 || output! < 0) return;
        for (let index = acquired.length - 1; index >= 0; index--) {
          const entry = acquired[index]!;
          const used = amountFor(entry.budget, input!, output!, true);
          if (used === null || !/^(0|[1-9][0-9]{0,29})$/.test(used) || BigInt(used) > BigInt(entry.amount)) continue;
          await entry.store.settleBudget(entry.principalId, entry.workspaceId, { ...entry, usedMicros: used });
          acquired.splice(index, 1);
        }
        await funding?.settle(input, output);
      }),
    };
  }

  async reserveExecutionBudgets(principalId:string,projectId:string,requestId:string,plan:ExecutionPlan,capabilities:readonly CapabilityDescriptor[], conversation?: ConversationBudgetScope){
    const ws=await this.executionWorkspace(principalId,projectId),now=this.now().toISOString();
    const task = await this.conversationBudgetSource(principalId, conversation);
    const store = conversation ? task?.store : this.store;
    const workspaceId = conversation ? task?.ws.id : ws.id;
    if (!store || !workspaceId) return;
    const budgets=conversation ? task!.budgets : (await this.listBudgets(principalId,ws.id)).filter(b=>b.enabled!==false&&(b.scope==='workspace'||b.scope==='project'&&b.subjectId===projectId||b.scope==='member'&&b.subjectId===principalId)&&(!b.startsAt||b.startsAt<=now)&&(!b.endsAt||b.endsAt>now));
    if(!budgets.length)return;
    const key=executionBudgetKey(projectId,requestId);
    const amounts=budgets.map(budget=>({budget,amount:estimateExecutionBudget(plan,capabilities,budget,now)}));
    // Resolve all unknown estimates before reserving any budget.
    if(amounts.some(item=>item.amount===null))throw new Error('budget_cost_unknown');
    const previous=await store.listRequestBudgetReservations(principalId,workspaceId,key);
    const acquired:Array<{budgetId:string;windowKey:string;requestId:string}>=[];
    try{
      for(const {budget,amount} of amounts){
        const reservation=await store.reserveBudget(principalId,workspaceId,{budgetId:budget.id,requestId:key,amountMicros:amount!});
        if(!reservation.ok||!reservation.windowKey)throw new Error(reservation.code??'budget_exceeded');
        if(!previous.some(item=>item.budget.id===budget.id))acquired.push({budgetId:budget.id,windowKey:reservation.windowKey,requestId:key});
      }
    }catch(error){for(const item of acquired)await store.compensateBudget(principalId,workspaceId,item);throw error;}
  }

  async releaseUndispatchedExecution(principalId:string,projectId:string,requestId:string){
    const key=executionBudgetKey(projectId,requestId);
    for(const {store,ws} of await this.executionSources(principalId,projectId))
      for(const item of await store.listRequestBudgetReservations(principalId,ws.id,key))await store.compensateBudget(principalId,ws.id,{budgetId:item.budget.id,windowKey:item.windowKey,requestId:key});
  }

  async settleExecutionBudgets(principalId:string,projectId:string,run:Run,receipts:readonly ExecutionReceipt[],values:readonly UsageValueReceipt[],capabilities:readonly CapabilityDescriptor[]){
    if(!['succeeded','failed','cancelled'].includes(run.status))return;
    const key=executionBudgetKey(projectId,run.requestId);
    for(const {store,ws} of await this.executionSources(principalId,projectId))for(const item of await store.listRequestBudgetReservations(principalId,ws.id,key)){
      const amount=settledExecutionBudget(item.budget,receipts,values,capabilities);
      // Unknown or underestimated costs retain the durable reservation for reconciliation.
      if(amount===null||BigInt(amount)>BigInt(item.amountMicros))continue;
      await store.settleBudget(principalId,ws.id,{budgetId:item.budget.id,windowKey:item.windowKey,requestId:key,usedMicros:amount});
    }
  }

  async checkCanMutatePolicy(principalId: string, workspaceId: string): Promise<void> {
    const members = await this.store.listMembers(principalId, workspaceId).catch(() => []);
    const role = members.find((m) => m.memberId === principalId)?.role ?? (await this.store.getWorkspace(principalId, workspaceId).then((ws) => (ws.ownerPrincipalId === principalId ? "owner" : undefined)).catch(() => undefined));
    if (role !== "owner" && role !== "admin") throw new Error("workspace_forbidden");
  }
}


export function executionBudgetKey(projectId:string,requestId:string):string{return 'execution_'+createHash('sha256').update(projectId+'\0'+requestId).digest('hex');}
export function estimateExecutionBudget(plan:ExecutionPlan,capabilities:readonly CapabilityDescriptor[],budget:WorkspaceBudget,at:string):string|null{
  if(budget.unit==='request')return '1'; // One admitted workflow request, independent of its internal steps.
  if(budget.unit==='money'&&budget.currency!=='USD')return null;
  let total=0n;const prices=new UsageValueEngine();
  for(const step of plan.steps){
    const cap=capabilities.find(item=>item.id===step.capabilityId&&item.version===step.capabilityVersion);if(!cap)return null;
    if(cap.effect!=='inference'){if(cap.dataDestination.kind==='local'||cap.dataDestination.kind==='public_source')continue;return null;}
    const binding=step.arguments.wire;
    if(!binding||binding.kind!=='literal')return null;
    let wire;let estimate;let reserved;
    try{wire=parseGatewayWireRequest(binding.value);const parsed={...JSON.parse(wire.body),max_tokens:plan.limits.maxOutputTokens};estimate=conservativeTokenEstimate(parsed);reserved=estimate?reservationTokenEstimate(parsed,estimate):undefined;}catch{return null;}
    if(!estimate||!reserved)return null;
    if(budget.unit==='token'){total+=BigInt(reserved.total)*BigInt(plan.limits.maxCalls);continue;}
    if(['ollama','vllm'].includes(wire.provider)||!budget.includeByokUsage)continue;
    const tariff=prices.findTariff(wire.provider,wire.model,'byok',at);if(!tariff||tariff.comparisonBasis!=='same_service')return null;
    // Money uses the same coherent measurement as the token reservation (catalog floor over
    // the declared output), never the bare chars/4 envelope alone.
    const measuredInput=reserved.total-estimate.output;
    const numerator=BigInt(measuredInput)*BigInt(tariff.inputMicrosPerMillion)+BigInt(estimate.output)*BigInt(tariff.outputMicrosPerMillion);
    total+=((numerator+999999n)/1000000n)*BigInt(plan.limits.maxCalls);
  }
  return total.toString();
}
function settledExecutionBudget(budget:WorkspaceBudget,receipts:readonly ExecutionReceipt[],values:readonly UsageValueReceipt[],capabilities:readonly CapabilityDescriptor[]):string|null{
  if(budget.unit==='request')return '1';
  let total=0n;
  for(const receipt of receipts){
    const cap=capabilities.find(c=>c.id===receipt.capabilityId&&c.version===receipt.capabilityVersion);if(!cap)return null;
    if(cap.effect!=='inference'){if(cap.dataDestination.kind==='local'||cap.dataDestination.kind==='public_source')continue;return null;}
    if(receipt.status!=='succeeded')return null;
    if(budget.unit==='token'){
      if(receipt.usage.basis!=='provider_reported'||receipt.usage.inputTokens===null||receipt.usage.outputTokens===null)return null;
      total+=BigInt(receipt.usage.inputTokens+receipt.usage.outputTokens);continue;
    }
    const value=values.find(v=>v.attemptId===receipt.attemptId&&v.runId===receipt.runId);if(!value)return null;
    if(value.accessMode==='local'||value.accessMode==='byok'&&!budget.includeByokUsage)continue;
    const amount=value.estimatedProviderCharge;if(!amount)return null;
    const numerator=BigInt(amount.numeratorMicros),denominator=BigInt(amount.denominator);total+=(numerator+denominator-1n)/denominator;
  }
  return total.toString();
}
