/**
 * TaskRecipeSpec — Contrato canônico e utilitários de integridade DAG.
 * Conforme DC0/DC1/DC3 e Prompt 01.
 */

import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical.js';

export const RECIPE_SCHEMA = 'uptokey.task-recipe.v2';

/**
 * Resolve um JSON Pointer (RFC 6901) estritamente.
 * @param {any} obj
 * @param {string} pointer
 * @returns {any}
 */
export function resolvePointer(obj, pointer) {
  if (pointer === '') return obj;
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) return undefined;
  
  const tokens = pointer.slice(1).split('/').map(t => t.replace(/~1/g, '/').replace(/~0/g, '~'));
  let current = obj;
  for (const token of tokens) {
    if (current === null || typeof current !== 'object') return undefined;
    // Prevenção contra poluição de protótipo
    if (token === '__proto__' || token === 'constructor' || token === 'prototype') return undefined;

    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) return undefined;
      const idx = Number(token);
      if (!Number.isSafeInteger(idx) || idx < 0 || idx >= current.length) return undefined;
      current = current[idx];
    } else {
      if (!Object.prototype.hasOwnProperty.call(current, token)) return undefined;
      current = current[token];
    }
  }
  return current;
}

/**
 * Calcula o digest canônico cobrindo todos os campos materiais de efeito, schemas e autoridade.
 * @param {any} recipe
 * @returns {string}
 */
export function computeRecipeDigest(recipe) {
  const payload = {
    proposalSchema: RECIPE_SCHEMA,
    id: String(recipe.id || ''),
    version: String(recipe.version || ''),
    catalogRevision: String(recipe.catalogRevision || ''),
    nodes: (recipe.nodes || []).map(n => ({
      id: String(n.id),
      capabilityRef: String(n.capabilityRef),
      capabilityVersion: String(n.capabilityVersion || '0.0.0'),
      dependsOn: [...(n.dependsOn || [])].map(String).sort(),
    })).sort((a, b) => a.id.localeCompare(b.id)),
    bindings: (recipe.bindings || []).map(b => ({
      from: String(b.from),
      pointer: String(b.pointer),
      to: String(b.to),
      transform: b.transform ? String(b.transform) : null,
    })).sort((a, b) => (a.from + a.to + a.pointer).localeCompare(b.from + b.to + b.pointer)),
    budgets: {
      maxCalls: Number(recipe.budgets?.maxCalls ?? 0),
      maxBytes: Number(recipe.budgets?.maxBytes ?? 0),
      maxDurationMs: Number(recipe.budgets?.maxDurationMs ?? 0),
      maxPages: Number(recipe.budgets?.maxPages ?? 0),
      maxRecords: Number(recipe.budgets?.maxRecords ?? 0),
      maxSemanticSpend: recipe.budgets?.maxSemanticSpend != null ? Number(recipe.budgets.maxSemanticSpend) : null,
    },
    effectManifest: {
      reads: [...(recipe.effectManifest?.reads || [])].map(String).sort(),
      writes: [...(recipe.effectManifest?.writes || [])].map(String).sort(),
      requiresInference: Boolean(recipe.effectManifest?.requiresInference),
      externalDestinations: [...(recipe.effectManifest?.externalDestinations || [])].map(String).sort(),
    },
    inputSchema: recipe.inputSchema || null,
    outputSchema: recipe.outputSchema || null,
    stopConditions: Array.isArray(recipe.stopConditions) ? recipe.stopConditions : [],
    sourceRequirements: recipe.sourceRequirements || null,
    approvalStrategy: recipe.approvalStrategy || 'materialize-next-plan',
  };
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

/**
 * Valida a estrutura de uma TaskRecipeSpec. Retorna erros encontrados.
 * @param {any} obj
 * @returns {string[]}
 */
export function validateRecipe(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return ['Recipe deve ser um objeto'];
  if (obj.proposalSchema !== RECIPE_SCHEMA) {
    errors.push(`proposalSchema esperado: '${RECIPE_SCHEMA}'`);
  }
  if (!obj.id || typeof obj.id !== 'string') errors.push('id é obrigatório e deve ser string');
  if (!obj.version || typeof obj.version !== 'string') errors.push('version é obrigatório e deve ser string');
  if (!Array.isArray(obj.nodes)) errors.push('nodes deve ser array');
  if (!Array.isArray(obj.bindings)) errors.push('bindings deve ser array');
  if (!obj.budgets || typeof obj.budgets !== 'object') {
    errors.push('budgets é obrigatório e deve ser um objeto');
  }
  if (!obj.effectManifest || typeof obj.effectManifest !== 'object') {
    errors.push('effectManifest é obrigatório e deve ser um objeto');
  }

  // Verificar revisionDigest se presente
  if (obj.revisionDigest !== undefined && obj.revisionDigest !== null) {
    if (typeof obj.revisionDigest !== 'string' || !/^[a-f0-9]{64}$/i.test(obj.revisionDigest)) {
      errors.push("revisionDigest deve ser um hash SHA-256 de 64 caracteres hexadecimais");
    }
  }

  // Verificar orçamentos finitos e não-negativos
  if (obj.budgets && typeof obj.budgets === 'object') {
    const b = obj.budgets;
    const requiredBudgets = ['maxCalls', 'maxDurationMs', 'maxBytes', 'maxPages', 'maxRecords'];
    for (const field of requiredBudgets) {
      if (b[field] === undefined || b[field] === null) {
        errors.push(`budgets.${field} é obrigatório`);
      } else if (!Number.isSafeInteger(b[field]) || b[field] < 0) {
        errors.push(`budgets.${field} deve ser um inteiro não-negativo finito`);
      }
    }
    if (b.maxSemanticSpend !== undefined && b.maxSemanticSpend !== null) {
      if (!Number.isFinite(b.maxSemanticSpend) || b.maxSemanticSpend < 0) {
        errors.push('budgets.maxSemanticSpend deve ser um número finito não-negativo ou null');
      }
    }
  }

  // Verificar nós e DAG
  if (Array.isArray(obj.nodes)) {
    const nodeIds = new Set();
    for (const node of obj.nodes) {
      if (!node || typeof node !== 'object') {
        errors.push('Nó de receita deve ser um objeto');
        continue;
      }
      if (!node.id || typeof node.id !== 'string') errors.push('node.id é obrigatório e deve ser string');
      if (!node.capabilityRef || typeof node.capabilityRef !== 'string') errors.push(`node ${node.id}: capabilityRef é obrigatório`);
      nodeIds.add(node.id);
    }

    // Verificar ciclos
    const visited = new Set();
    const stack = new Set();
    function hasCycle(nodeId) {
      if (stack.has(nodeId)) return true;
      if (visited.has(nodeId)) return false;
      visited.add(nodeId);
      stack.add(nodeId);
      const node = obj.nodes.find(n => n.id === nodeId);
      if (node?.dependsOn && Array.isArray(node.dependsOn)) {
        for (const dep of node.dependsOn) {
          if (!nodeIds.has(dep)) {
            errors.push(`Nó ${nodeId} depende de ${dep} que não existe`);
          }
          if (hasCycle(dep)) return true;
        }
      }
      stack.delete(nodeId);
      return false;
    }

    for (const node of obj.nodes) {
      if (hasCycle(node.id)) {
        errors.push(`Ciclo detectado envolvendo nó ${node.id}`);
        break;
      }
    }

    // Verificar bindings referem nós existentes
    if (Array.isArray(obj.bindings)) {
      for (const b of obj.bindings) {
        if (!b || typeof b !== 'object') {
          errors.push('binding deve ser um objeto');
          continue;
        }
        if (!nodeIds.has(b.from)) errors.push(`Binding.from '${b.from}' não é um nó existente`);
        const toNode = b.to?.split('.')[0];
        if (toNode && !nodeIds.has(toNode)) errors.push(`Binding.to '${b.to}' refere nó inexistente '${toNode}'`);
        if (typeof b.pointer !== 'string' || (!b.pointer.startsWith('/') && b.pointer !== '')) {
          errors.push(`Binding pointer '${b.pointer}' deve ser um JSON Pointer RFC 6901 válido`);
        }
      }
    }
  }

  return errors;
}

export function isTaskRecipeSpec(obj) {
  return validateRecipe(obj).length === 0;
}

export function topologicalSort(nodes) {
  if (!Array.isArray(nodes)) throw new Error('nodes deve ser um array');
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const inDegree = new Map(nodes.map(n => [n.id, 0]));

  for (const node of nodes) {
    for (const dep of (node.dependsOn || [])) {
      inDegree.set(node.id, (inDegree.get(node.id) || 0) + 1);
    }
  }

  const queue = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const sorted = [];
  while (queue.length > 0) {
    const id = queue.shift();
    sorted.push(nodeMap.get(id));
    for (const node of nodes) {
      if (node.dependsOn?.includes(id)) {
        inDegree.set(node.id, inDegree.get(node.id) - 1);
        if (inDegree.get(node.id) === 0) queue.push(node.id);
      }
    }
  }

  if (sorted.length !== nodes.length) {
    throw new Error('Ciclo detectado no DAG da receita');
  }
  return sorted;
}
