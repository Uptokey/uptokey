/**
 * E2-13.B — versioned presets / DAG reusing recipe + composition concepts.
 * Preset versions are immutable; edits mint a new version.
 */

import { AutomationError, isId } from "./automation-types.ts";

export type PresetStepKind = "recipe" | "composition" | "channel_preview" | "channel_send" | "chat";

export type PresetStep = {
  id: string;
  kind: PresetStepKind;
  /** Recipe id / composition id / channel id — opaque reference, not a secret. */
  ref: string;
  /** Optional binding keys (validated as identifiers). */
  bindings?: Record<string, string>;
};

export type PresetEdge = { from: string; to: string };

export type AutomationPreset = {
  id: string;
  version: number;
  name: string;
  principalId: string;
  projectId: string;
  steps: readonly PresetStep[];
  edges: readonly PresetEdge[];
  createdAt: string;
  superseded?: boolean;
};

export type DagValidationError =
  | "empty_steps"
  | "duplicate_step"
  | "unknown_edge_endpoint"
  | "cycle"
  | "disconnected"
  | "binding_invalid";

function validateDag(steps: readonly PresetStep[], edges: readonly PresetEdge[]): void {
  if (!steps.length) throw new AutomationError("empty_steps");
  const ids = new Set<string>();
  for (const step of steps) {
    if (!isId(step.id) || !isId(step.ref)) throw new AutomationError("step_invalid");
    if (!["recipe", "composition", "channel_preview", "channel_send", "chat"].includes(step.kind)) {
      throw new AutomationError("step_kind_invalid");
    }
    if (ids.has(step.id)) throw new AutomationError("duplicate_step");
    ids.add(step.id);
    if (step.bindings) {
      for (const [k, v] of Object.entries(step.bindings)) {
        if (!isId(k) || typeof v !== "string" || v.length > 512) throw new AutomationError("binding_invalid");
      }
    }
  }
  const adj = new Map<string, string[]>();
  for (const id of ids) adj.set(id, []);
  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) throw new AutomationError("unknown_edge_endpoint");
    adj.get(e.from)!.push(e.to);
  }
  // cycle detect (DFS colors)
  const color = new Map<string, 0 | 1 | 2>();
  for (const id of ids) color.set(id, 0);
  const visit = (n: string): void => {
    const c = color.get(n)!;
    if (c === 1) throw new AutomationError("cycle");
    if (c === 2) return;
    color.set(n, 1);
    for (const m of adj.get(n)!) visit(m);
    color.set(n, 2);
  };
  for (const id of ids) visit(id);
  // weak connectivity ignoring direction via undirected BFS from first step
  const undirected = new Map<string, Set<string>>();
  for (const id of ids) undirected.set(id, new Set());
  for (const e of edges) {
    undirected.get(e.from)!.add(e.to);
    undirected.get(e.to)!.add(e.from);
  }
  const start = steps[0]!.id;
  const seen = new Set<string>([start]);
  const q = [start];
  while (q.length) {
    const n = q.shift()!;
    for (const m of undirected.get(n)!) {
      if (!seen.has(m)) {
        seen.add(m);
        q.push(m);
      }
    }
  }
  if (seen.size !== ids.size && edges.length > 0) throw new AutomationError("disconnected");
}

/** Topological order — reuses composition-style linearization for execution prep. */
export function topologicalOrder(preset: AutomationPreset): string[] {
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const s of preset.steps) {
    indeg.set(s.id, 0);
    adj.set(s.id, []);
  }
  for (const e of preset.edges) {
    adj.get(e.from)!.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  const q = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  const out: string[] = [];
  while (q.length) {
    const n = q.shift()!;
    out.push(n);
    for (const m of adj.get(n)!) {
      const d = (indeg.get(m) ?? 0) - 1;
      indeg.set(m, d);
      if (d === 0) q.push(m);
    }
  }
  if (out.length !== preset.steps.length) throw new AutomationError("cycle");
  return out;
}

export class AutomationPresetStore {
  private byKey = new Map<string, AutomationPreset[]>(); // id -> versions ascending
  private seq = 0;

  private key(principalId: string, projectId: string, id: string): string {
    return `${principalId}:${projectId}:${id}`;
  }

  create(
    principalId: string,
    projectId: string,
    input: { id?: string; name: string; steps: PresetStep[]; edges?: PresetEdge[] },
    createdAt: string,
  ): AutomationPreset {
    if (!isId(principalId) || !isId(projectId)) throw new AutomationError("principal_or_project_invalid");
    const id = input.id ?? `preset_${(++this.seq).toString(36)}`;
    if (!isId(id)) throw new AutomationError("preset_id_invalid");
    const edges = input.edges ?? [];
    validateDag(input.steps, edges);
    const preset: AutomationPreset = {
      id,
      version: 1,
      name: String(input.name).slice(0, 200),
      principalId,
      projectId,
      steps: structuredClone(input.steps),
      edges: structuredClone(edges),
      createdAt,
    };
    const k = this.key(principalId, projectId, id);
    if (this.byKey.has(k)) throw new AutomationError("preset_exists", 409);
    this.byKey.set(k, [preset]);
    return structuredClone(preset);
  }

  /** Immutable version bump — previous marked superseded. */
  revise(
    principalId: string,
    projectId: string,
    id: string,
    input: { name?: string; steps: PresetStep[]; edges?: PresetEdge[] },
    createdAt: string,
  ): AutomationPreset {
    const k = this.key(principalId, projectId, id);
    const versions = this.byKey.get(k);
    if (!versions?.length) throw new AutomationError("preset_missing", 404);
    const edges = input.edges ?? [];
    validateDag(input.steps, edges);
    const prev = versions[versions.length - 1]!;
    prev.superseded = true;
    const next: AutomationPreset = {
      id,
      version: prev.version + 1,
      name: input.name !== undefined ? String(input.name).slice(0, 200) : prev.name,
      principalId,
      projectId,
      steps: structuredClone(input.steps),
      edges: structuredClone(edges),
      createdAt,
    };
    versions.push(next);
    return structuredClone(next);
  }

  get(principalId: string, projectId: string, id: string, version?: number): AutomationPreset | undefined {
    const versions = this.byKey.get(this.key(principalId, projectId, id));
    if (!versions?.length) return undefined;
    if (version === undefined) return structuredClone(versions[versions.length - 1]!);
    const found = versions.find((v) => v.version === version);
    return found ? structuredClone(found) : undefined;
  }

  list(principalId: string, projectId: string): AutomationPreset[] {
    const out: AutomationPreset[] = [];
    for (const [k, versions] of this.byKey) {
      if (!k.startsWith(`${principalId}:${projectId}:`)) continue;
      out.push(structuredClone(versions[versions.length - 1]!));
    }
    return out;
  }

  /** Recipe-shaped plan bindings: expand DAG into ordered recipe/composition refs. */
  toRecipePlanSkeleton(preset: AutomationPreset): { orderedRefs: { stepId: string; kind: PresetStepKind; ref: string }[] } {
    const order = topologicalOrder(preset);
    const byId = new Map(preset.steps.map((s) => [s.id, s]));
    return {
      orderedRefs: order.map((stepId) => {
        const s = byId.get(stepId)!;
        return { stepId, kind: s.kind, ref: s.ref };
      }),
    };
  }

  /** Durable persistence (E2-13 correção): serializa versões por chave. */
  exportState(): { entries: Array<[string, AutomationPreset[]]>; seq: number } {
    return { entries: [...this.byKey.entries()], seq: this.seq };
  }

  restoreState(state: { entries: Array<[string, AutomationPreset[]]>; seq: number }): void {
    this.byKey = new Map(state.entries.map(([key, versions]) => [key, structuredClone(versions)]));
    this.seq = state.seq;
  }
}
