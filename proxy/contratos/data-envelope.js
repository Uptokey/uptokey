/**
 * DataEnvelope v2 — Contrato canônico Uptokey.
 * Conforme especificação DC0/DC1 e Prompt 01.
 */

export const DATA_ENVELOPE_SCHEMA = 'uptokey.data-envelope.v2';
export const DATA_ENVELOPE_VERSION = '2.0.0';

const ALLOWED_ENVELOPE_KEYS = new Set([
  'schema',
  'version',
  'records',
  'completeness',
  'units',
  'warnings',
  'createdAt',
]);

const ALLOWED_COMPLETENESS_KEYS = new Set([
  'requested',
  'obtained',
  'truncationReason',
  'unavailableSources',
  'partial',
]);

const ALLOWED_UNITS_KEYS = new Set([
  'timezone',
  'currency',
  'measureSystem',
]);

const ALLOWED_RECORD_KEYS = new Set([
  'id',
  'materialType',
  'materialTypeSource',
  'title',
  'summary',
  'authors',
  'publisher',
  'language',
  'provenance',
  'rights',
  'relations',
  'fields',
]);

const ALLOWED_PROVENANCE_KEYS = new Set([
  'sourceId',
  'sourceRecordId',
  'canonicalUrl',
  'identifiers',
  'retrievedAt',
  'sourcePublishedAt',
  'query',
  'executionId',
  'adapterVersion',
  'rawArtifactRef',
]);

const ALLOWED_RIGHTS_KEYS = new Set([
  'termsUrl',
  'verifiedAt',
  'holder',
  'attribution',
  'permissions',
]);

const VALID_MATERIAL_TYPES = new Set([
  'news',
  'press_release',
  'journal_article',
  'preprint',
  'correction',
  'retraction',
  'indicator',
  'event',
  'entity',
  'unknown',
]);

function isValidIsoDate(str) {
  if (typeof str !== 'string' || !str) return false;
  const timestamp = Date.parse(str);
  if (!Number.isFinite(timestamp)) return false;
  return new Date(timestamp).toISOString() === str;
}

export function createEnvelope(overrides = {}) {
  return {
    schema: DATA_ENVELOPE_SCHEMA,
    version: DATA_ENVELOPE_VERSION,
    records: [],
    completeness: {
      requested: 0,
      obtained: 0,
      truncationReason: null,
      unavailableSources: [],
      partial: false,
    },
    units: null,
    warnings: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

export function createRecord(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('DataRecord data deve ser um objeto');
  }
  if (!data.provenance || !data.provenance.sourceId) {
    throw new Error('DataRecord requer provenance.sourceId');
  }
  if (!data.provenance.retrievedAt) {
    throw new Error('DataRecord requer provenance.retrievedAt');
  }
  return {
    id: data.id || (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : 'rec_' + Math.random().toString(36).slice(2)),
    materialType: data.materialType || 'unknown',
    materialTypeSource: data.materialTypeSource || null,
    title: data.title || null,
    summary: data.summary || null,
    authors: Array.isArray(data.authors) ? data.authors : [],
    publisher: data.publisher || null,
    language: data.language || null,
    provenance: {
      sourceId: data.provenance.sourceId,
      sourceRecordId: data.provenance.sourceRecordId || null,
      canonicalUrl: data.provenance.canonicalUrl || null,
      identifiers: data.provenance.identifiers && typeof data.provenance.identifiers === 'object' ? data.provenance.identifiers : {},
      retrievedAt: data.provenance.retrievedAt,
      sourcePublishedAt: data.provenance.sourcePublishedAt || null,
      query: data.provenance.query || null,
      executionId: data.provenance.executionId || null,
      adapterVersion: data.provenance.adapterVersion || null,
      rawArtifactRef: data.provenance.rawArtifactRef || null,
    },
    rights: data.rights || null,
    relations: Array.isArray(data.relations) ? data.relations : [],
    fields: data.fields && typeof data.fields === 'object' ? data.fields : {},
  };
}

export function validateEnvelope(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return ['Envelope deve ser um objeto'];
  }

  for (const key of Object.keys(obj)) {
    if (!ALLOWED_ENVELOPE_KEYS.has(key)) {
      errors.push(`Campo desconhecido no envelope: ${key}`);
    }
  }

  if (obj.schema !== DATA_ENVELOPE_SCHEMA) {
    errors.push(`Schema inválido: esperado '${DATA_ENVELOPE_SCHEMA}', recebido '${obj.schema}'`);
  }

  if (obj.version !== DATA_ENVELOPE_VERSION) {
    errors.push(`Versão não suportada: esperado '${DATA_ENVELOPE_VERSION}', recebido '${obj.version}'`);
  }

  if (!isValidIsoDate(obj.createdAt)) {
    errors.push(`createdAt deve ser uma data ISO UTC válida: '${obj.createdAt}'`);
  }

  if (!Array.isArray(obj.records)) {
    errors.push('records deve ser um array');
  }

  if (!obj.completeness || typeof obj.completeness !== 'object' || Array.isArray(obj.completeness)) {
    errors.push('completeness é obrigatório e deve ser um objeto');
  } else {
    for (const key of Object.keys(obj.completeness)) {
      if (!ALLOWED_COMPLETENESS_KEYS.has(key)) {
        errors.push(`Campo desconhecido em completeness: ${key}`);
      }
    }
    const c = obj.completeness;
    if (!Number.isSafeInteger(c.requested) || c.requested < 0) {
      errors.push('completeness.requested deve ser um inteiro não-negativo');
    }
    if (!Number.isSafeInteger(c.obtained) || c.obtained < 0) {
      errors.push('completeness.obtained deve ser um inteiro não-negativo');
    }
    if (typeof c.partial !== 'boolean') {
      errors.push('completeness.partial deve ser booleano');
    }
    if (c.truncationReason !== null && c.truncationReason !== undefined && typeof c.truncationReason !== 'string') {
      errors.push('completeness.truncationReason deve ser string ou null');
    }
    if (c.unavailableSources !== undefined && !Array.isArray(c.unavailableSources)) {
      errors.push('completeness.unavailableSources deve ser um array');
    }
  }

  if (obj.units !== null && obj.units !== undefined) {
    if (typeof obj.units !== 'object' || Array.isArray(obj.units)) {
      errors.push('units deve ser um objeto ou null');
    } else {
      for (const key of Object.keys(obj.units)) {
        if (!ALLOWED_UNITS_KEYS.has(key)) {
          errors.push(`Campo desconhecido em units: ${key}`);
        }
      }
    }
  }

  if (obj.warnings !== undefined && !Array.isArray(obj.warnings)) {
    errors.push('warnings deve ser um array');
  }

  if (Array.isArray(obj.records)) {
    for (let i = 0; i < obj.records.length; i++) {
      const r = obj.records[i];
      if (!r || typeof r !== 'object' || Array.isArray(r)) {
        errors.push(`records[${i}] deve ser um objeto`);
        continue;
      }
      for (const key of Object.keys(r)) {
        if (!ALLOWED_RECORD_KEYS.has(key)) {
          errors.push(`Campo desconhecido em records[${i}]: ${key}`);
        }
      }
      if (typeof r.id !== 'string' || !r.id) {
        errors.push(`records[${i}].id é obrigatório`);
      }
      if (!r.materialType || !VALID_MATERIAL_TYPES.has(r.materialType)) {
        errors.push(`records[${i}].materialType é obrigatório e deve ser válido`);
      }
      if (!r.provenance || typeof r.provenance !== 'object') {
        errors.push(`records[${i}].provenance é obrigatório`);
      } else {
        for (const pKey of Object.keys(r.provenance)) {
          if (!ALLOWED_PROVENANCE_KEYS.has(pKey)) {
            errors.push(`Campo desconhecido em records[${i}].provenance: ${pKey}`);
          }
        }
        if (typeof r.provenance.sourceId !== 'string' || !r.provenance.sourceId) {
          errors.push(`records[${i}].provenance.sourceId é obrigatório`);
        }
        if (!isValidIsoDate(r.provenance.retrievedAt)) {
          errors.push(`records[${i}].provenance.retrievedAt deve ser data ISO UTC válida`);
        }
      }
      if (r.rights !== null && r.rights !== undefined) {
        if (typeof r.rights !== 'object' || Array.isArray(r.rights)) {
          errors.push(`records[${i}].rights deve ser um objeto ou null`);
        } else {
          for (const rtKey of Object.keys(r.rights)) {
            if (!ALLOWED_RIGHTS_KEYS.has(rtKey)) {
              errors.push(`Campo desconhecido em records[${i}].rights: ${rtKey}`);
            }
          }
          if (r.rights.permissions !== undefined && r.rights.permissions !== null) {
            if (typeof r.rights.permissions !== 'object' || Array.isArray(r.rights.permissions)) {
              errors.push(`records[${i}].rights.permissions deve ser um objeto`);
            } else {
              for (const [permScope, permVal] of Object.entries(r.rights.permissions)) {
                if (permVal !== true && permVal !== false && permVal !== null && permVal !== 'unknown') {
                  errors.push(`records[${i}].rights.permissions.${permScope} deve ser booleano, null ou 'unknown'`);
                }
              }
            }
          }
        }
      }
    }
  }

  return errors;
}

export function isDataEnvelope(obj) {
  return validateEnvelope(obj).length === 0;
}

export function validateDataEnvelope(obj) {
  const errors = validateEnvelope(obj);
  if (errors.length > 0) {
    throw new Error(`DataEnvelope inválido:\n${errors.map(e => ` - ${e}`).join('\n')}`);
  }
}

export function isDataRecord(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  if (typeof obj.id !== 'string' || !obj.id) return false;
  if (!obj.materialType || !VALID_MATERIAL_TYPES.has(obj.materialType)) return false;
  if (!obj.provenance || typeof obj.provenance !== 'object') return false;
  if (typeof obj.provenance.sourceId !== 'string' || !obj.provenance.sourceId) return false;
  return isValidIsoDate(obj.provenance.retrievedAt);
}
