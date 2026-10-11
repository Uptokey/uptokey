import { OPEN_METEO_SPEC } from './open-meteo.ts';
import { NAGER_DATE_SPEC } from './nager-date.ts';
import { REST_COUNTRIES_SPEC } from './rest-countries.ts';
import { TIME_API_SPEC } from './time-api.ts';
import { ZIPPOPOTAM_SPEC } from './zippopotam.ts';
import { FRANKFURTER_SPEC } from './frankfurter.ts';
import { GITHUB_PUBLIC_SPEC, POKEAPI_SPEC, WORLD_BANK_SPEC } from './conversation-public.ts';
export { GITHUB_PUBLIC_SPEC, POKEAPI_SPEC, WORLD_BANK_SPEC };
import { PUBMED_EUTILS_SPEC, ARXIV_FEED_SPEC } from './scientific-literature.ts';
export { PUBMED_EUTILS_SPEC, ARXIV_FEED_SPEC };
import { NASA_APOD_SPEC } from './nasa-apod.ts';
export { NASA_APOD_SPEC };
import { PUBLIC_SERVICE_SPECS } from './public-services.ts';
export { PUBLIC_SERVICE_SPECS, PUBLIC_SERVICE_ALIASES } from './public-services.ts';

export {
  OPEN_METEO_SPEC,
  NAGER_DATE_SPEC,
  REST_COUNTRIES_SPEC,
  TIME_API_SPEC,
  ZIPPOPOTAM_SPEC,
  FRANKFURTER_SPEC,
};

export interface CuratedServiceMetadata {
  serviceId: string;
  domain: string;
  officialUrl: string;
  specUrl: string;
  revision: string;
  codeLicense: string;
  dataLicense: string;
  commercialTerms: string;
  authentication: string;
  rateLimit: string | null;
  attribution: string;
  consultedAt: string;
  /** Rights verified in the source terms; absent/unknown scopes stay 'unknown'. */
  contentRights?: CuratedContentRights | null;
}

export type CuratedPermission = boolean | 'unknown';
export interface CuratedContentRights {
  termsUrl: string;
  verifiedAt: string;
  permissions: Record<'obtain' | 'store' | 'display' | 'export' | 'model_input' | 'train', CuratedPermission>;
}

export const CURATED_SPEC_ENTRIES = [
  {spec: OPEN_METEO_SPEC, source: 'open-meteo'},
  {spec: NAGER_DATE_SPEC, source: 'nager-date'},
  {spec: REST_COUNTRIES_SPEC, source: 'rest-countries'},
  {spec: TIME_API_SPEC, source: 'time-api'},
  {spec: ZIPPOPOTAM_SPEC, source: 'zippopotam'},
  {spec: FRANKFURTER_SPEC, source: 'frankfurter'},
  {spec: GITHUB_PUBLIC_SPEC, source: 'conversation-public'},
  {spec: POKEAPI_SPEC, source: 'conversation-public'},
  {spec: WORLD_BANK_SPEC, source: 'conversation-public'},
  {spec: PUBMED_EUTILS_SPEC, source: 'scientific-literature'},
  {spec: ARXIV_FEED_SPEC, source: 'scientific-literature'},
  {spec: NASA_APOD_SPEC, source: 'nasa-apod'},
  ...PUBLIC_SERVICE_SPECS.map(spec => ({spec, source: 'public-services'})),
] as const;
export const CURATED_SPECS = CURATED_SPEC_ENTRIES.map(entry => entry.spec);
