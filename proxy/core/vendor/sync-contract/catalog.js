/**
 * Catalog — Contrato canônico e pipeline de elegibilidade e ranking.
 * Conforme DC0/DC1 e Prompt 01.
 */

export function createInstrumentProfile(data) {
  if (!data || typeof data !== 'object') throw new Error('data deve ser um objeto');
  if (!data.capabilityId) throw new Error('capabilityId é obrigatório');
  if (!data.displayName) throw new Error('displayName é obrigatório');

  return {
    capabilityId: data.capabilityId,
    capabilityVersion: data.capabilityVersion || '0.0.0',
    catalogRevision: data.catalogRevision || 'draft',
    displayName: data.displayName,
    description: data.description || '',
    groupIds: Array.isArray(data.groupIds) ? data.groupIds : [],
    taskTags: Array.isArray(data.taskTags) ? data.taskTags : [],
    locales: Array.isArray(data.locales) ? data.locales : [],
    coverage: {
      entities: Array.isArray(data.coverage?.entities) ? data.coverage.entities : [],
      regions: Array.isArray(data.coverage?.regions) ? data.coverage.regions : [],
      temporalRange: data.coverage?.temporalRange || null,
      actions: Array.isArray(data.coverage?.actions) ? data.coverage.actions : ['read'],
      destinations: Array.isArray(data.coverage?.destinations) ? data.coverage.destinations : [],
    },
    authMode: data.authMode || 'unknown',
    accessEvidence: data.accessEvidence || {
      officialUrl: '',
      checkedAt: new Date().toISOString(),
      versionOrPlan: null,
      region: null,
      productionAllowed: data.accessEvidence?.productionAllowed ?? null,
      commercialAllowed: null,
      status: data.accessEvidence?.status ?? 'unknown',
    },
    rights: data.rights || {
      metadataAllowed: null,
      summaryAllowed: null,
      fullTextAllowed: null,
      localProcessingAllowed: null,
      cacheAllowed: null,
      redistributionAllowed: null,
      modelInputAllowed: null,
      trainingAllowed: null,
    },
    freshness: data.freshness || null,
    quotaEvidence: data.quotaEvidence || null,
    connectionState: data.connectionState || 'unknown',
    outputSchemaRef: data.outputSchemaRef || null,
    provenancePolicy: data.provenancePolicy || null,
    termsRevision: data.termsRevision || null,
  };
}

export function validateInstrumentProfile(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return ['Profile deve ser um objeto'];
  if (!obj.capabilityId || typeof obj.capabilityId !== 'string') errors.push('capabilityId é obrigatório');
  if (!obj.displayName || typeof obj.displayName !== 'string') errors.push('displayName é obrigatório');
  if (!Array.isArray(obj.groupIds)) errors.push('groupIds deve ser array');
  const validAuth = ['anonymous', 'user_key', 'oauth', 'local_service', 'unknown'];
  if (obj.authMode && !validAuth.includes(obj.authMode)) {
    errors.push(`authMode inválido: ${obj.authMode}`);
  }
  const validConnection = [
    'catalogado', 'candidato', 'experimental', 'verificado', 'indisponivel',
    'cataloged', 'candidate', 'experimental', 'verified', 'unavailable', 'unknown',
  ];
  if (obj.connectionState && !validConnection.includes(obj.connectionState)) {
    errors.push(`connectionState inválido: ${obj.connectionState}`);
  }
  return errors;
}

export function isInstrumentProfile(obj) {
  return validateInstrumentProfile(obj).length === 0;
}

/**
 * Pipeline de 3 etapas para ranking de instrumentos com filtro estrito de elegibilidade.
 * @param {Array<any>} profiles
 * @param {Object} intent
 * @param {Object} userContext
 * @param {Array<any>} healthSnapshot
 * @returns {Array<any>}
 */
export function rankInstruments(profiles, intent = {}, userContext = {}, healthSnapshot = []) {
  if (!Array.isArray(profiles)) return [];
  const healthMap = new Map((healthSnapshot || []).map(h => [h.provider, h]));

  // ETAPA 1: Filtrar — somente candidatos que PODEM executar legal e operacionalmente
  const eligible = profiles.filter(p => {
    // 1. Estado de conexão: itens meramente catalogados não são executáveis
    if (!p.connectionState || p.connectionState === 'unavailable' || p.connectionState === 'indisponivel' || p.connectionState === 'unknown' || p.connectionState === 'cataloged' || p.connectionState === 'catalogado') {
      return false;
    }

    // 2. Autenticação: se não for anônimo nem serviço local, requer conexão ativa do usuário
    if (p.authMode !== 'anonymous' && p.authMode !== 'local_service') {
      if (!Array.isArray(userContext.activeConnections) || !userContext.activeConnections.includes(p.capabilityId)) {
        return false;
      }
    }

    // 3. Saúde do provedor e quota observada no health snapshot
    const h = healthMap.get(p.capabilityId);
    if (h) {
      if (h.status === 'down' || h.status === 'unavailable') return false;
      if (typeof h.quotaRemaining === 'number' && h.quotaRemaining <= 0) return false;
    }

    // 4. Evidência de quota no próprio perfil: se declarada/observada <= 0, não é executável
    if (p.quotaEvidence) {
      if (typeof p.quotaEvidence.value === 'number' && p.quotaEvidence.value <= 0) return false;
      if (typeof p.quotaEvidence.observed === 'number' && p.quotaEvidence.observed <= 0) return false;
    }

    // 5. Restrições de termos / produção: produção desconhecida ou restrita não é executável
    if (p.accessEvidence && (p.accessEvidence.productionAllowed === false || p.accessEvidence.status === 'restricted')) {
      return false;
    }

    // 6. Vigência temporal
    if (p.freshness?.validUntil) {
      const validUntil = Date.parse(p.freshness.validUntil);
      if (Number.isFinite(validUntil) && validUntil <= Date.now()) return false;
    }

    // 7. Região
    if (userContext.region && p.coverage?.regions?.length > 0 && !p.coverage.regions.includes(userContext.region)) {
      return false;
    }

    // 8. Ações necessárias solicitadas pela intenção
    if (Array.isArray(intent.requiredActions) && intent.requiredActions.length > 0) {
      const actions = p.coverage?.actions || [];
      for (const reqAction of intent.requiredActions) {
        if (!actions.includes(reqAction)) return false;
      }
    }

    // 9. Destino
    if (intent.destination && p.coverage?.destinations?.length > 0 && !p.coverage.destinations.includes(intent.destination)) {
      return false;
    }

    return true;
  });

  // ETAPA 2: Ordenar por adequação
  const scored = eligible.map(p => {
    let score = 0;
    if (intent.candidateCapabilityRefs?.includes(p.capabilityId)) score += 10;
    if (Array.isArray(intent.missingFields)) {
      for (const f of intent.missingFields) {
        if (p.coverage?.entities?.includes(f)) score += 10;
      }
    }
    if (Array.isArray(intent.taskTags)) {
      for (const t of intent.taskTags) {
        if (p.taskTags?.includes(t)) score += 5;
      }
    }
    if (intent.locale && p.locales?.includes(intent.locale)) score += 3;
    if (p.rights?.localProcessingAllowed === true || p.rights?.localProcessing === true) score += 2;
    if (p.freshness?.observedAt) {
      const parsed = Date.parse(p.freshness.observedAt);
      if (Number.isFinite(parsed)) {
        const age = Date.now() - parsed;
        if (age >= 0 && age < 3600000) score += 2;
      }
    }
    return { profile: p, score };
  });

  scored.sort((a, b) => b.score - a.score);

  // ETAPA 3: Desempatar
  for (let i = 0; i < scored.length - 1; i++) {
    if (scored[i].score === scored[i + 1].score) {
      const prefA = (userContext.preferences?.includes(scored[i].profile.capabilityId) || userContext.preferredProviders?.includes(scored[i].profile.capabilityId)) ? 1 : 0;
      const prefB = (userContext.preferences?.includes(scored[i + 1].profile.capabilityId) || userContext.preferredProviders?.includes(scored[i + 1].profile.capabilityId)) ? 1 : 0;
      if (prefB !== prefA) {
        if (prefB > prefA) {
          [scored[i], scored[i + 1]] = [scored[i + 1], scored[i]];
        }
      } else {
        const costA = scored[i].profile.quotaEvidence?.value ?? Infinity;
        const costB = scored[i + 1].profile.quotaEvidence?.value ?? Infinity;
        if (costB < costA) {
          [scored[i], scored[i + 1]] = [scored[i + 1], scored[i]];
        }
      }
    }
  }

  return scored.map(s => s.profile);
}

export function rankCandidates(candidates, intent, userContext, healthSnapshots) {
  return rankInstruments(candidates, intent, userContext, healthSnapshots);
}
