/**
 * Recipe Compiler — Compilação de receitas TaskRecipeSpec em ExecutionPlan W0.
 * Conforme DC3 e Prompt 03. Não substitui o executor central do W0.
 */

import { validateRecipe, topologicalSort, resolvePointer, computeRecipeDigest } from "../../../contratos/recipe.js";
import { createHash } from 'node:crypto';

export type CapabilityType = 'read' | 'local_transform' | 'local_artifact' | 'write' | 'inference';
export type CapabilityStatus = 'available' | 'blocked' | 'unresolved';

export interface CapabilityMapping {
  capabilityId: string;
  version: number;
  type: CapabilityType;
  status: CapabilityStatus;
  reason?: string;
}

/**
 * Tabela canônica de resolução: nós das receitas R-DC-01..07 -> catálogo real.
 */
export const CAPABILITY_MAPPINGS: Record<string, CapabilityMapping> = {
  'catalogue:rss.read': {
    capabilityId: 'api.rss.read',
    version: 1,
    type: 'read',
    status: 'available',
  },
  'catalogue:local.dedup': {
    capabilityId: 'local.dedup',
    version: 1,
    type: 'local_transform',
    status: 'available',
  },
  'catalogue:science.lookup': {
    capabilityId: 'sources.crossref.search',
    version: 1,
    type: 'read',
    status: 'available',
  },
  'catalogue:science.search': {
    capabilityId: 'sources.crossref.search',
    version: 1,
    type: 'read',
    status: 'available',
  },
  'catalogue:science.cite': {
    capabilityId: 'science.cite',
    version: 1,
    type: 'local_transform',
    status: 'available',
  },
  'catalogue:local.export': {
    capabilityId: 'local.export',
    version: 1,
    type: 'local_transform',
    status: 'available',
  },
  'catalogue:local.table.create': {
    capabilityId: 'local.table.create',
    version: 1,
    type: 'local_artifact',
    status: 'available',
  },
  'catalogue:local.document.create': {
    capabilityId: 'local.document.create',
    version: 1,
    type: 'local_artifact',
    status: 'available',
  },
  'catalogue:weather.forecast': {
    capabilityId: 'api.open_meteo.get_forecast',
    version: 1,
    type: 'read',
    status: 'available',
  },
  'catalogue:fx.rate': {
    capabilityId: 'api.frankfurter.get_latest_rates',
    version: 1,
    type: 'read',
    status: 'available',
  },
  'catalogue:geocoding.read': {
    capabilityId: 'api.zippopotam.get_by_postal_code',
    version: 1,
    type: 'read',
    status: 'available',
  },
  'catalogue:holidays.read': {
    capabilityId: 'api.nager_date.get_public_holidays',
    version: 1,
    type: 'read',
    status: 'available',
  },
  'catalogue:worldbank.indicators': {
    capabilityId: 'api.world_bank.get_country_indicator',
    version: 1,
    type: 'read',
    status: 'available',
  },
  'catalogue:github.issues.read': {
    capabilityId: 'api.github_public.get_public_repository_issues',
    version: 1,
    type: 'read',
    status: 'available',
  },
  'catalogue:github.changes.read': {
    capabilityId: 'api.github_public.get_public_repository_pulls',
    version: 1,
    type: 'read',
    status: 'available',
  },
  'catalogue:crm.contacts.read': {
    capabilityId: 'crm.contacts.read',
    version: 1,
    type: 'read',
    status: 'blocked',
    reason: 'Requer conexão OAuth CRM não configurada',
  },
  'catalogue:wikidata.entity': {
    capabilityId: 'api.wikidata.search',
    version: 1,
    type: 'read',
    status: 'blocked',
    reason: 'Endpoint Wikidata em homologação experimental',
  },
  'catalogue:games.search': {
    capabilityId: 'games.search',
    version: 1,
    type: 'read',
    status: 'unresolved',
    reason: 'Instrumento não registrado no catálogo ativo',
  },
  'catalogue:calendar.availability': {
    capabilityId: 'calendar.availability',
    version: 1,
    type: 'read',
    status: 'blocked',
    reason: 'Requer conexão OAuth Calendar não configurada',
  },
};

export interface CompilationResult {
  recipeId: string;
  success: boolean;
  resolvedNodes: Array<{ nodeId: string; capabilityRef: string; mapping: CapabilityMapping }>;
  unresolvedNodes: Array<{ nodeId: string; capabilityRef: string; reason: string }>;
  executionPlan?: any;
  revisionDigest?: string;
  errors?: string[];
}

export function compileRecipe(
  recipeSpec: any,
  userInputs: Record<string, any> = {},
  contextSnapshot: { id: string; digest: string; projectId: string } = {
    id: 'ctx_default',
    digest: 'a'.repeat(64),
    projectId: 'p_default',
  }
): CompilationResult {
  const errors = validateRecipe(recipeSpec);
  if (errors.length > 0) {
    return {
      recipeId: recipeSpec?.id || 'unknown',
      success: false,
      resolvedNodes: [],
      unresolvedNodes: [],
      errors: [`Validação estrutural da receita falhou: ${errors.join(', ')}`],
    };
  }

  const resolvedNodes: CompilationResult['resolvedNodes'] = [];
  const unresolvedNodes: CompilationResult['unresolvedNodes'] = [];

  for (const node of recipeSpec.nodes) {
    const mapping = CAPABILITY_MAPPINGS[node.capabilityRef];
    if (!mapping || mapping.status !== 'available') {
      unresolvedNodes.push({
        nodeId: node.id,
        capabilityRef: node.capabilityRef,
        reason: mapping?.reason || `Capacidade '${node.capabilityRef}' não registrada no catálogo ativo`,
      });
    } else {
      resolvedNodes.push({
        nodeId: node.id,
        capabilityRef: node.capabilityRef,
        mapping,
      });
    }
  }

  // Falta de qualquer instrumento DEVE aparecer antes da aprovação — não suprimir nó nem simular resultado
  if (unresolvedNodes.length > 0) {
    return {
      recipeId: recipeSpec.id,
      success: false,
      resolvedNodes,
      unresolvedNodes,
      errors: unresolvedNodes.map(u => `Nó '${u.nodeId}' não pode executar: ${u.reason}`),
    };
  }

  // Ordenação topológica estrita do DAG
  const sortedNodes = topologicalSort(recipeSpec.nodes);
  const revisionDigest = computeRecipeDigest(recipeSpec);

  // Compila em passos de ExecutionPlan W0
  const steps = sortedNodes.map((node, index) => {
    const mapping = CAPABILITY_MAPPINGS[node.capabilityRef];
    const incomingBindings = (recipeSpec.bindings || []).filter((b: any) => b.to.startsWith(node.id + '.'));

    return {
      id: node.id,
      stepIndex: index,
      capabilityId: mapping.capabilityId,
      capabilityVersion: mapping.version,
      type: mapping.type,
      dependsOn: node.dependsOn || [],
      bindings: incomingBindings.map((b: any) => ({
        fromStepId: b.from,
        pointer: b.pointer,
        targetField: b.to.split('.')[1] || 'input',
      })),
      inputs: userInputs[node.id] || {},
    };
  });

  const executionPlan = {
    schemaVersion: 1,
    planId: `plan_${recipeSpec.id}_${createHash('sha256').update(revisionDigest).digest('hex').slice(0, 16)}`,
    recipeId: recipeSpec.id,
    recipeVersion: recipeSpec.version,
    revisionDigest,
    projectId: contextSnapshot.projectId,
    contextSnapshotId: contextSnapshot.id,
    contextSnapshotDigest: contextSnapshot.digest,
    createdAt: new Date().toISOString(),
    status: 'prepared',
    budgets: recipeSpec.budgets,
    effectManifest: recipeSpec.effectManifest,
    steps,
  };

  return {
    recipeId: recipeSpec.id,
    success: true,
    resolvedNodes,
    unresolvedNodes: [],
    executionPlan,
    revisionDigest,
  };
}

/**
 * Resolve ligação de entrada a partir da saída de um nó anterior usando RFC 6901 Pointer.
 */
export function resolveStepInput(
  binding: { fromStepId: string; pointer: string; targetField: string },
  completedOutputs: Record<string, any>
): { valid: boolean; value?: any; reason?: string } {
  const sourceOutput = completedOutputs[binding.fromStepId];
  if (sourceOutput === undefined || sourceOutput === null) {
    return { valid: false, reason: `Saída do nó fonte '${binding.fromStepId}' ausente` };
  }

  const extracted = resolvePointer(sourceOutput, binding.pointer);
  if (extracted === undefined) {
    return {
      valid: false,
      reason: `JSON Pointer '${binding.pointer}' não resolveu na saída do nó '${binding.fromStepId}'`,
    };
  }

  return { valid: true, value: extracted };
}
