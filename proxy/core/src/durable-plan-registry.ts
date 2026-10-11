/**
 * Durable install-plan registry — persists plans to disk via atomic-json.
 * Replaces the in-memory defaultPlanRegistry for reload survival.
 */

import { readJson, writeJsonAtomic } from "./atomic-json.ts";
import type { InstallPlan } from "./install-plan.ts";

interface PlanStore {
  plans: Record<string, InstallPlan>;
}

export class DurablePlanRegistry {
  private readonly path: string;
  private cache: Map<string, InstallPlan> | null = null;

  constructor(path: string) {
    this.path = path;
  }

  async get(planId: string): Promise<InstallPlan | undefined> {
    const map = await this.load();
    return map.get(planId);
  }

  async set(plan: InstallPlan): Promise<void> {
    const map = await this.load();
    map.set(plan.id, plan);
    await this.persist(map);
  }

  async delete(planId: string): Promise<boolean> {
    const map = await this.load();
    const existed = map.delete(planId);
    if (existed) await this.persist(map);
    return existed;
  }

  async size(): Promise<number> {
    const map = await this.load();
    return map.size;
  }

  async clear(): Promise<void> {
    this.cache = new Map();
    await this.persist(this.cache);
  }

  private async load(): Promise<Map<string, InstallPlan>> {
    if (this.cache) return this.cache;
    const store = await readJson<PlanStore>(this.path, { plans: {} });
    this.cache = new Map(Object.entries(store.plans));
    return this.cache;
  }

  private async persist(map: Map<string, InstallPlan>): Promise<void> {
    const store: PlanStore = { plans: Object.fromEntries(map) };
    await writeJsonAtomic(this.path, store);
  }
}
