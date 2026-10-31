import crypto from 'crypto';
import { canonicalJson } from "../../../contratos/canonical.js";
import { topologicalSort } from "../../../contratos/recipe.js";
import { canonicalPlanPayload } from "../../../contratos/workflow.js";
import { ALL_CURATED_OPERATIONS } from '../../api-instruments/src/index.ts';
import { prepareApiCall } from '../../api-instruments/src/governed-transport.ts';

const KNOWN_PLACES = {
  tokyo: { country: 'jp', postalcode: '100-0001', postal_code: '100-0001', latitude: 35.6762, longitude: 139.6503 },
  osaka: { country: 'jp', postalcode: '530-0001', postal_code: '530-0001', latitude: 34.6937, longitude: 135.5023 },
  paris: { country: 'fr', postalcode: '75001', postal_code: '75001', latitude: 48.8566, longitude: 2.3522 },
  lyon: { country: 'fr', postalcode: '69001', postal_code: '69001', latitude: 45.7640, longitude: 4.8357 },
  'sao paulo': { country: 'br', postalcode: '01000-000', postal_code: '01000-000', latitude: -23.5505, longitude: -46.6333 },
  'são paulo': { country: 'br', postalcode: '01000-000', postal_code: '01000-000', latitude: -23.5505, longitude: -46.6333 },
  'rio de janeiro': { country: 'br', postalcode: '20000-000', postal_code: '20000-000', latitude: -22.9068, longitude: -43.1729 },
  london: { country: 'gb', postalcode: 'ec1a', postal_code: 'ec1a', latitude: 51.5074, longitude: -0.1278 },
  'new york': { country: 'us', postalcode: '10001', postal_code: '10001', latitude: 40.7128, longitude: -74.0060 },
  berlin: { country: 'de', postalcode: '10115', postal_code: '10115', latitude: 52.5200, longitude: 13.4050 },
  rome: { country: 'it', postalcode: '00100', postal_code: '00100', latitude: 41.9028, longitude: 12.4964 },
  madrid: { country: 'es', postalcode: '28001', postal_code: '28001', latitude: 40.4168, longitude: -3.7038 }
};

function resolvePlace(placeName) {
  if (!placeName || typeof placeName !== 'string') {
    return null;
  }
  const key = placeName.trim().toLowerCase();
  return KNOWN_PLACES[key] || null;
}

export const CAPABILITY_MAPPINGS = {
  // RSS & Science
  'catalogue:rss.read': {
    capabilityId: 'api.rss.read',
    version: 1,
    type: 'read',
    status: 'candidate',
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
  // Local transforms
  'catalogue:local.dedup': {
    capabilityId: 'local.dedup',
    version: 1,
    type: 'local_transform',
    status: 'local_transform',
  },
  'catalogue:local.table.create': {
    capabilityId: 'local.table.create',
    version: 1,
    type: 'local_transform',
    status: 'local_transform',
  },
  'catalogue:local.document.create': {
    capabilityId: 'local.document.create',
    version: 1,
    type: 'local_transform',
    status: 'local_transform',
  },
  'catalogue:local.export': {
    capabilityId: 'local.export',
    version: 1,
    type: 'local_transform',
    status: 'local_transform',
  },
  'catalogue:science.cite': {
    capabilityId: 'science.cite',
    version: 1,
    type: 'local_transform',
    status: 'local_transform',
  },
  // Weather & Geocoding & Holidays & FX
  'catalogue:geocoding.read': {
    capabilityId: 'api.zippopotam.get_postal_location',
    version: 1,
    type: 'read',
    status: 'available',
  },
  'catalogue:weather.forecast': {
    capabilityId: 'api.open_meteo.get_weather_forecast',
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
  'catalogue:fx.rate': {
    capabilityId: 'api.frankfurter.get_latest_exchange_rates',
    version: 1,
    type: 'read',
    status: 'available',
  },
  // World Bank & GitHub
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
  'catalogue:github.pulls': {
    capabilityId: 'api.github_public.get_public_repository_pulls',
    version: 1,
    type: 'read',
    status: 'available',
  },
  // Other curated ops
  'catalogue:countries.info': {
    capabilityId: 'api.rest_countries.get_country_by_name',
    version: 1,
    type: 'read',
    status: 'available',
  },
  'catalogue:pokemon.info': {
    capabilityId: 'api.pokeapi.get_pokemon',
    version: 1,
    type: 'read',
    status: 'available',
  },
  'catalogue:time.timezone': {
    capabilityId: 'api.time_api.get_current_time_zone',
    version: 1,
    type: 'read',
    status: 'available',
  },
  // OAuth blocked
  'catalogue:crm.contacts.read': {
    capabilityId: 'integration.crm.contacts.read',
    version: 1,
    type: 'read',
    status: 'requires_oauth',
    reason: 'Requires authenticated CRM OAuth connection'
  },
  'catalogue:crm.query': {
    capabilityId: 'integration.crm.query',
    version: 1,
    type: 'read',
    status: 'requires_oauth',
    reason: 'Requires authenticated CRM OAuth connection'
  },
  'catalogue:crm.update': {
    capabilityId: 'integration.crm.update',
    version: 1,
    type: 'read',
    status: 'requires_oauth',
    reason: 'Requires authenticated CRM OAuth connection'
  },
  'catalogue:email.send': {
    capabilityId: 'integration.email.send',
    version: 1,
    type: 'write',
    status: 'requires_oauth',
    reason: 'Requires authenticated Email OAuth connection'
  },
  'catalogue:calendar.event.create': {
    capabilityId: 'integration.calendar.event.create',
    version: 1,
    type: 'write',
    status: 'requires_oauth',
    reason: 'Requires authenticated Calendar OAuth connection'
  },
  'catalogue:chat.message.send': {
    capabilityId: 'integration.chat.message.send',
    version: 1,
    type: 'write',
    status: 'requires_oauth',
    reason: 'Requires authenticated Chat OAuth connection'
  },
  'catalogue:task.create': {
    capabilityId: 'integration.task.create',
    version: 1,
    type: 'write',
    status: 'requires_oauth',
    reason: 'Requires authenticated Task OAuth connection'
  },
  'catalogue:doc.append': {
    capabilityId: 'integration.doc.append',
    version: 1,
    type: 'write',
    status: 'requires_oauth',
    reason: 'Requires authenticated Document OAuth connection'
  },
  'catalogue:storage.upload': {
    capabilityId: 'integration.storage.upload',
    version: 1,
    type: 'write',
    status: 'requires_oauth',
    reason: 'Requires authenticated Cloud Storage OAuth connection'
  },
  'catalogue:spreadsheet.append': {
    capabilityId: 'integration.spreadsheet.append',
    version: 1,
    type: 'write',
    status: 'requires_oauth',
    reason: 'Requires authenticated Spreadsheet OAuth connection'
  }
};

export function compileRecipe(recipe, inputs, contextSnapshot) {
  if (!recipe || !recipe.id) {
    return {
      success: false,
      reason: 'Invalid recipe definition',
      executionPlan: null,
      blockedNodes: []
    };
  }

  if (!contextSnapshot || !contextSnapshot.id || !contextSnapshot.digest) {
    return {
      success: false,
      reason: 'Missing durable context snapshot required for plan compilation',
      executionPlan: null,
      blockedNodes: []
    };
  }

  // Topological sorting
  let nodes;
  try {
    nodes = topologicalSort(recipe.nodes || []);
  } catch (err) {
    return {
      success: false,
      reason: `Cycle detected or invalid DAG: ${err.message}`,
      executionPlan: null,
      blockedNodes: []
    };
  }

  // Check for unregistered or oauth capabilities
  const blockedNodes = [];
  for (const node of nodes) {
    const mapping = CAPABILITY_MAPPINGS[node.capabilityRef];
    if (!mapping) {
      blockedNodes.push({ nodeId: node.id, capabilityRef: node.capabilityRef, reason: 'Capability not found in registry' });
    } else if (mapping.status === 'requires_oauth') {
      blockedNodes.push({ nodeId: node.id, capabilityRef: node.capabilityRef, reason: mapping.reason });
    } else if (mapping.status === 'unregistered') {
      blockedNodes.push({ nodeId: node.id, capabilityRef: node.capabilityRef, reason: mapping.reason });
    }
  }

  if (blockedNodes.length > 0) {
    return {
      success: false,
      reason: `Recipe ${recipe.id} blocked: requires external OAuth or unregistered capabilities (${blockedNodes.map(b => b.nodeId).join(', ')})`,
      executionPlan: null,
      blockedNodes
    };
  }

  // Candidate-only capabilities check: if all nodes are candidate-only, recipe is not executable
  const isCandidateOnly = nodes.length > 0 && nodes.every(n => {
    const m = CAPABILITY_MAPPINGS[n.capabilityRef];
    return m && m.status === 'candidate' && m.type !== 'local_transform';
  });
  if (isCandidateOnly) {
    return {
      success: false,
      reason: 'Candidate-only capabilities cannot produce an executable plan',
      executionPlan: null,
      blockedNodes: []
    };
  }

  // Specific validations
  if (inputs.repoUrl) {
    try {
      const u = new URL(inputs.repoUrl);
      if (u.hostname !== 'github.com' && u.hostname !== 'www.github.com') {
        return {
          success: false,
          reason: 'Apenas repositórios do github.com são suportados no momento',
          executionPlan: null,
          blockedNodes: []
        };
      }
    } catch {
      return {
        success: false,
        reason: 'URL do repositório inválida',
        executionPlan: null,
        blockedNodes: []
      };
    }
  }

  if (recipe.id === 'R-DC-07' && !inputs.repoUrl && (!inputs.owner || !inputs.repo)) {
    return {
      success: false,
      reason: 'R-DC-07 requer repoUrl ou owner/repo válidos',
      executionPlan: null,
      blockedNodes: []
    };
  }

  // Generate W0 executable steps
  const steps = [];
  const stepMap = new Map();

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const mapping = CAPABILITY_MAPPINGS[node.capabilityRef];

    // Local transforms are not dispatched external capability steps
    if (!mapping || mapping.type === 'local_transform') {
      continue;
    }

    const stepId = `s_${steps.length}_${node.id.replace(/[^A-Za-z0-9_]/g, '_')}`;
    stepMap.set(node.id, stepId);

    const args = {};
    const relevantBindings = (recipe.bindings || []).filter(b => b.to && b.to.startsWith(node.id + '.'));
    for (const b of relevantBindings) {
      const paramName = (b.to.split('.')[1] || 'input').toLowerCase();
      if (b.from && stepMap.has(b.from)) {
        let outputName = 'records';
        if (b.pointer && typeof b.pointer === 'string') {
          const clean = b.pointer.replace(/^\/+/g, '').replace(/[^a-zA-Z0-9_.-]/g, '_').toLowerCase();
          outputName = /^[a-z]/.test(clean) ? clean.slice(0, 128) : ('records_' + clean).slice(0, 128);
        }
        args[paramName] = {
          kind: 'step_output',
          stepId: stepMap.get(b.from),
          output: outputName
        };
      } else if (inputs[b.from] !== undefined) {
        args[paramName] = {
          kind: 'literal',
          value: inputs[b.from]
        };
      }
    }

    if (mapping.capabilityId === 'sources.crossref.search') {
      args['query'] = { kind: 'literal', value: inputs.topic || inputs.query || 'science' };
    }
    if (mapping.capabilityId === 'api.rss.read') {
      if (inputs.feedUrls && inputs.feedUrls[0]) {
        args['feed_url'] = { kind: 'literal', value: inputs.feedUrls[0] };
      } else if (inputs.feedUrl) {
        args['feed_url'] = { kind: 'literal', value: inputs.feedUrl };
      }
    }

    if (Object.keys(args).length === 0) {
      args['query'] = {
        kind: 'literal',
        value: inputs[node.id] || null
      };
    }

    if (mapping && mapping.capabilityId.startsWith('api.')) {
      const operation = ALL_CURATED_OPERATIONS.find(op => op.id === mapping.capabilityId);
      if (operation) {
        const rawArgs = {};
        for (const p of operation.parameters) {
          if (inputs[p.name] !== undefined) {
            rawArgs[p.name] = inputs[p.name];
          } else if (inputs[node.id] && typeof inputs[node.id] === 'object' && inputs[node.id][p.name] !== undefined) {
            rawArgs[p.name] = inputs[node.id][p.name];
          } else {
            for (const val of Object.values(inputs)) {
              if (val && typeof val === 'object' && val[p.name] !== undefined) {
                rawArgs[p.name] = val[p.name];
                break;
              }
            }
          }
        }

        // Specific parameter resolution for public endpoints
        if (mapping.capabilityId.startsWith('api.github_public.')) {
          if (inputs.repoUrl && (!rawArgs.owner || !rawArgs.repo)) {
            try {
              const url = new URL(inputs.repoUrl);
              const parts = url.pathname.split('/').filter(Boolean);
              if (parts.length >= 2) {
                rawArgs.owner = parts[0];
                rawArgs.repo = parts[1].replace(/\.git$/, '');
              }
            } catch {
              const match = String(inputs.repoUrl).match(/github\.com[\/:]([^\/]+)\/([^\/]+)/);
              if (match) {
                rawArgs.owner = match[1];
                rawArgs.repo = match[2].replace(/\.git$/, '');
              }
            }
          }
          if (rawArgs.per_page === undefined) rawArgs.per_page = 10;
        } else if (mapping.capabilityId === 'api.world_bank.get_country_indicator') {
          if (!rawArgs.country && inputs.countries && inputs.countries[0]) rawArgs.country = inputs.countries[0];
          if (!rawArgs.indicator && inputs.indicators && inputs.indicators[0]) rawArgs.indicator = inputs.indicators[0];
          if (!rawArgs.format) rawArgs.format = 'json';
          if (rawArgs.per_page === undefined) rawArgs.per_page = 10;
        } else if (mapping.capabilityId === 'api.frankfurter.get_latest_exchange_rates') {
          if (!rawArgs.base && inputs.currency) rawArgs.base = inputs.currency;
          if (!rawArgs.base && inputs.baseCurrency) rawArgs.base = inputs.baseCurrency;
        } else if (mapping.capabilityId === 'api.nager_date.get_public_holidays') {
          if (!rawArgs.year && inputs.date) rawArgs.year = parseInt(inputs.date.slice(0, 4), 10) || 2026;
          if (args.countrycode && args.countrycode.kind === 'step_output') {
            rawArgs.countryCode = 'BR';
          } else if (!rawArgs.countryCode) {
            rawArgs.countryCode = inputs.countryCode || 'BR';
          }
        } else if (mapping.capabilityId === 'api.open_meteo.get_weather_forecast') {
          if (args.latitude && args.latitude.kind === 'step_output') {
            rawArgs.latitude = 0;
            rawArgs.longitude = 0;
          } else {
            const placeInput = (Array.isArray(inputs.places) && inputs.places[0]) || inputs.place || null;
            if (placeInput) {
              const resolvedGeo = resolvePlace(placeInput);
              if (!resolvedGeo) {
                return {
                  success: false,
                  reason: `Local desconhecido '${placeInput}': coordenadas e CEP não foram encontrados no diretório verificado`,
                  executionPlan: null,
                  blockedNodes: []
                };
              }
              if (rawArgs.latitude === undefined) rawArgs.latitude = resolvedGeo.latitude;
              if (rawArgs.longitude === undefined) rawArgs.longitude = resolvedGeo.longitude;
            } else if (inputs.latitude !== undefined && inputs.longitude !== undefined) {
              rawArgs.latitude = inputs.latitude;
              rawArgs.longitude = inputs.longitude;
            }
          }
        } else if (mapping.capabilityId === 'api.zippopotam.get_postal_location') {
          delete rawArgs.postal_code;
          const placeInput = (Array.isArray(inputs.places) && inputs.places[0]) || inputs.place || null;
          if (placeInput) {
            const resolvedGeo = resolvePlace(placeInput);
            if (!resolvedGeo) {
              return {
                success: false,
                reason: `Local desconhecido '${placeInput}': coordenadas e CEP não foram encontrados no diretório verificado`,
                executionPlan: null,
                blockedNodes: []
              };
            }
            if (!rawArgs.country) rawArgs.country = resolvedGeo.country;
            if (!rawArgs.postalcode) rawArgs.postalcode = resolvedGeo.postalcode || resolvedGeo.postal_code;
          } else {
            if (inputs.country) rawArgs.country = inputs.country;
            if (inputs.postalcode || inputs.postal_code) rawArgs.postalcode = inputs.postalcode || inputs.postal_code;
          }
        }

        try {
          const prepared = prepareApiCall(operation, rawArgs);
          args['prepared_call'] = {
            kind: 'literal',
            value: JSON.parse(JSON.stringify(prepared))
          };
        } catch (err) {
          return {
            success: false,
            reason: `Falha na preparação da chamada para ${operation.id}: ${err.message}`,
            executionPlan: null,
            blockedNodes: []
          };
        }
      }
    }

    steps.push({
      id: stepId,
      capabilityId: mapping.capabilityId,
      capabilityVersion: mapping.version || 1,
      arguments: args
    });
  }

  // If all nodes were candidate or none yielded executable steps, recipe is not executable
  if (steps.length === 0) {
    return {
      success: false,
      reason: 'Candidate-only capabilities cannot produce an executable plan',
      executionPlan: null,
      blockedNodes: []
    };
  }

  // Build canonical plan identity - must include nodes so node change changes identity
  const idHash = crypto.createHash('sha256')
    .update(canonicalJson({
      recipeId: recipe.id,
      recipeVersion: recipe.version,
      nodes: nodes.map(n => ({ id: n.id, capabilityRef: n.capabilityRef, dependsOn: n.dependsOn || [] })),
      inputs,
      snapshotId: contextSnapshot.id,
      snapshotDigest: contextSnapshot.digest
    }), 'utf8')
    .digest('hex');

  const planId = `plan_${recipe.id.replace(/[^A-Za-z0-9_]/g, '_')}_${idHash.substring(0, 16)}`;
  const createdAt = new Date().toISOString();

  const limits = {
    maxSteps: Math.min(12, Math.max(1, steps.length || 1)),
    maxCalls: Math.min(24, Math.max(1, recipe.budgets?.maxCalls || steps.length || 1)),
    maxOutputTokens: 10000,
    timeoutMs: Math.min(300000, Math.max(1000, recipe.budgets?.maxDurationMs || 30000)),
    maxOutputBytes: 131072,
  };

  const dummyDigest = '0'.repeat(64);
  const candidatePlan = {
    schemaVersion: 1,
    id: planId,
    createdAt,
    projectId: contextSnapshot.projectId,
    projectRevision: contextSnapshot.projectRevision || 1,
    contextSnapshotId: contextSnapshot.id,
    contextSnapshotDigest: contextSnapshot.digest,
    steps,
    limits,
    digest: dummyDigest
  };

  const planDigest = crypto.createHash('sha256')
    .update(canonicalPlanPayload(candidatePlan), 'utf8')
    .digest('hex');

  const executionPlan = {
    ...candidatePlan,
    digest: planDigest
  };

  return {
    success: true,
    reason: null,
    executionPlan,
    blockedNodes: []
  };
}
