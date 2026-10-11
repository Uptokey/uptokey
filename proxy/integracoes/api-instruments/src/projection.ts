import type { CuratedOperation, GovernedReadOutcome, PreparedApiCall } from './types.ts';

export interface StructuredOutcome {
  schemaVersion: 1;
  serviceId: string;
  operationId: string;
  attribution: string;
  origin: string | null;
  retrievedAt: string | null;
  status: 'succeeded' | 'partial' | 'empty' | 'failed';
  byteLength: number;
  cached: boolean;
  units?: Record<string, string>;
  unitSources?: Record<string, 'response' | 'request'>;
  data: unknown;
  error?: string;
  summary: string;
}

const record = (value: unknown): Record<string, any> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null;
const present = (value: unknown): boolean => value !== undefined && value !== null;
const timestamp = (value: unknown): string | null => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const list = (value: string | undefined): string[] => value?.split(',').map(item => item.trim()).filter(Boolean) ?? [];

function hasMissingFields(operation: CuratedOperation, prepared: PreparedApiCall, data: unknown): boolean {
  const obj = record(data);
  switch (operation.operationId) {
    case 'search_pubmed': {
      if (!obj || !record(obj.esearchresult)) return true;
      const res = obj.esearchresult;
      if (!Array.isArray(res.idlist)) return true;
      const count = Number(res.count ?? 0);
      const retmax = Number(res.retmax ?? prepared.query.retmax ?? 20);
      return count > retmax || count > res.idlist.length;
    }
    case 'get_pubmed_summaries': {
      if (!obj || !record(obj.result)) return true;
      const res = obj.result;
      if (!Array.isArray(res.uids) || res.uids.length === 0) return true;
      const requested = list(prepared.query.id);
      return res.uids.some((uid: string) => !record(res[uid]) || res[uid].error) || (requested.length > 0 && requested.some(id => !present(res[id])));
    }
    case 'get_category_feed': {
      if (typeof data === 'string') {
        return !data.includes('<item>') && !data.includes('<entry>');
      }
      return !Array.isArray(data) || data.length === 0;
    }
    case 'get_public_repository_issues':
    case 'get_public_repository_pulls':
      // A full page may have successors; never silently declare an exhaustive list.
      return !Array.isArray(data) || data.length >= Number(prepared.query.per_page ?? 10) || data.some(item => !record(item) || typeof item.number !== 'number' || typeof item.title !== 'string');
    case 'get_pokemon':
      return !obj || !Number.isSafeInteger(obj.id) || typeof obj.name !== 'string' || !Number.isFinite(obj.height) || !Number.isFinite(obj.weight) || !Array.isArray(obj.types);
    case 'get_country_indicator': {
      if (!Array.isArray(data) || data.length !== 2 || !record(data[0]) || !Array.isArray(data[1])) return true;
      return Number(data[0].pages) !== 1 || data[1].some((item: any) => !record(item) || !record(item.indicator) || !record(item.country) || typeof item.date !== 'string' || !Number.isFinite(item.value));
    }
    case 'get_weather_forecast': {
      if (!obj) return true;
      if (!['current', 'hourly', 'daily'].some(group => record(obj[group]) && Object.entries(obj[group]).some(([field, value]) => field !== 'time' && present(value)))) return true;
      for (const group of ['current', 'hourly', 'daily']) {
        const requested = list(prepared.query[group]);
        if (requested.length && (!record(obj[group]) || requested.some(field => !present(obj[group][field]) || (Array.isArray(obj[group][field]) && obj[group][field].length === 0)))) return true;
      }
      return false;
    }
    case 'get_ground_elevation': return !obj || !Array.isArray(obj.elevation) || obj.elevation.length === 0 || obj.elevation.some((value: unknown) => typeof value !== 'number' || !Number.isFinite(value));
    case 'get_public_holidays': return !Array.isArray(data) || data.some(item => !record(item) || typeof item.date !== 'string' || typeof item.name !== 'string');
    case 'get_long_weekends': return !Array.isArray(data) || data.some(item => !record(item) || typeof item.startDate !== 'string' || typeof item.endDate !== 'string' || typeof item.dayCount !== 'number');
    case 'get_is_today_public_holiday': return !obj || typeof obj.isPublicHoliday !== 'boolean';
    case 'get_country_by_name':
    case 'get_countries_by_region': {
      const fields = list(prepared.query.fields);
      return !Array.isArray(data) || data.some(item => !record(item) || (fields.length ? fields : ['name']).some(field => !present(item[field])));
    }
    case 'get_postal_location': return !obj || !Array.isArray(obj.places) || obj.places.length === 0 || obj.places.some((place: any) => !record(place) || !present(place['place name']) || !present(place.latitude) || !present(place.longitude));
    case 'get_current_time_zone':
    case 'get_time_by_coordinate': return !obj || typeof obj.dateTime !== 'string' || typeof obj.timeZone !== 'string';
    case 'get_latest_exchange_rates':
    case 'get_historical_exchange_rates': {
      if (!obj || typeof obj.base !== 'string' || !record(obj.rates) || Object.keys(obj.rates).length === 0) return true;
      return Object.values(obj.rates).some(value => typeof value !== 'number' || !Number.isFinite(value)) || list(prepared.query.symbols).some(symbol => !present(obj.rates[symbol]));
    }
    default: return false;
  }
}

/** Projection preserves observed provenance and distinguishes requested units from response metadata. */
export function projectApiOutcome(operation: CuratedOperation, prepared: PreparedApiCall, outcome: GovernedReadOutcome): StructuredOutcome {
  const base = { schemaVersion: 1 as const, serviceId: operation.serviceId, operationId: operation.operationId, attribution: operation.metadata.attribution };
  if (outcome.kind === 'failed') return { ...base, origin: null, retrievedAt: null, status: 'failed', byteLength: 0, cached: false, data: null, error: outcome.code, summary: `Falha na consulta: ${outcome.code}` };
  if (outcome.origin !== prepared.origin || outcome.operation !== operation.operationId) return { ...base, origin: null, retrievedAt: null, status: 'failed', byteLength: outcome.byteLength, cached: Boolean(outcome.cached), data: null, error: 'api_projection_provenance_mismatch', summary: 'Origem do resultado não corresponde à chamada preparada' };
  const data = outcome.data;
  const obj = record(data);
  let empty = !present(data) || (Array.isArray(data) && data.length === 0) || (obj && Object.keys(obj).length === 0);
  if (operation.operationId === 'search_pubmed' && obj?.esearchresult?.idlist?.length === 0) {
    empty = true;
  }
  if (operation.operationId === 'get_pubmed_summaries' && obj?.result?.uids?.length === 0) {
    empty = true;
  }
  if (operation.operationId === 'get_category_feed' && typeof data === 'string' && !data.includes('<item>') && !data.includes('<entry>')) {
    empty = true;
  }
  const status = empty ? 'empty' : hasMissingFields(operation, prepared, data) ? 'partial' : 'succeeded';
  const units: Record<string, string> = {};
  const unitSources: Record<string, 'response' | 'request'> = {};
  const setUnit = (field: string, unit: string, source: 'response' | 'request') => { if (!units[field] || source === 'response') { units[field] = unit; unitSources[field] = source; } };
  if (operation.serviceId === 'pokeapi' && obj) {
    // Documented source units, with original numerical values retained in data.
    if (Number.isFinite(obj.height)) setUnit('height', 'dm', 'response');
    if (Number.isFinite(obj.weight)) setUnit('weight', 'hg', 'response');
  }
  if (operation.serviceId === 'open_meteo' && obj) {
    for (const group of ['current', 'hourly', 'daily']) {
      const values = record(obj[group]); const metadata = record(obj[`${group}_units`]);
      if (metadata && values) for (const [field, value] of Object.entries(metadata)) if (typeof value === 'string' && present(values[field])) setUnit(`${group}.${field}`, value, 'response');
    }
    // Retain the established flat keys for current values without conflating current/hourly units.
    const current = record(obj.current);
    if (current) {
      for (const field of Object.keys(current)) if (units[`current.${field}`]) setUnit(field, units[`current.${field}`]!, 'response');
      const temperature = ({ celsius: '°C', fahrenheit: '°F' } as Record<string, string>)[prepared.query.temperature_unit ?? ''];
      const wind = ({ kmh: 'km/h', ms: 'm/s', mph: 'mph', kn: 'knots' } as Record<string, string>)[prepared.query.wind_speed_unit ?? ''];
      if (temperature && present(current.temperature_2m)) setUnit('temperature_2m', temperature, 'request');
      if (wind && present(current.wind_speed_10m)) setUnit('wind_speed_10m', wind, 'request');
    }
  }
  if (operation.serviceId === 'frankfurter' && obj && record(obj.rates)) {
    const currency = typeof obj.base === 'string' ? obj.base : prepared.query.base;
    if (currency) { const source = typeof obj.base === 'string' ? 'response' : 'request'; setUnit('base', currency, source); setUnit('rates', `ratio_relative_to_${currency}`, source); }
  }
  return { ...base, origin: outcome.origin, retrievedAt: timestamp(outcome.retrievedAt), status, byteLength: outcome.byteLength, cached: Boolean(outcome.cached), ...(Object.keys(units).length ? { units, unitSources } : {}), data: structuredClone(data), summary: status === 'empty' ? 'Resposta vazia, sem dados para apresentar' : status === 'partial' ? 'Dados parciais: campos ausentes ou consulta limitada a uma página' : 'Resultado disponível' };
}

export const projectApiInstrumentOutcome = projectApiOutcome;

/** Metadata must come from the original receipt/envelope, never the time of reloading the artifact. */
export function projectFromDurableArtifact(artifactBytes: Uint8Array, operation: CuratedOperation, prepared: PreparedApiCall, metadata?: { retrievedAt?: string; origin?: string; cached?: boolean }): StructuredOutcome {
  try {
    const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(artifactBytes));
    const projection = projectApiOutcome(operation, prepared, { kind: 'completed', data, operation: operation.operationId, origin: metadata?.origin ?? prepared.origin, retrievedAt: metadata?.retrievedAt ?? '', byteLength: artifactBytes.byteLength, cached: metadata?.cached ?? false });
    if (!metadata?.origin) projection.origin = null;
    return projection;
  } catch {
    return { schemaVersion: 1, serviceId: operation.serviceId, operationId: operation.operationId, attribution: operation.metadata.attribution, origin: metadata?.origin ?? null, retrievedAt: timestamp(metadata?.retrievedAt), status: 'failed', byteLength: artifactBytes.byteLength, cached: metadata?.cached ?? false, data: null, error: 'api_invalid_durable_artifact', summary: 'Não foi possível carregar o artefato durável' };
  }
}
