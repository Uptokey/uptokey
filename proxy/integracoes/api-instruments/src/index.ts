export * from './types.ts';
export * from './specs/index.ts';
export * from './importer.ts';
export * from './governed-transport.ts';
export * from './progressive-discovery.ts';
export * from './typesafe-intent-adapter.ts';
export * from './service-integration.ts';
export * from './provenance-cache.ts';
export * from './pagination.ts';
export * from './pagination-execution.ts';
export * from './projection.ts';
export * from './learned-recipes.ts';
export * from './public-contract.ts';
export * from './productivity/index.ts';

import type { CuratedOperation } from './types.ts';
import { importCuratedService } from './importer.ts';
import {
  CURATED_SPECS,
  OPEN_METEO_SPEC,
  NAGER_DATE_SPEC,
  REST_COUNTRIES_SPEC,
  TIME_API_SPEC,
  ZIPPOPOTAM_SPEC,
  FRANKFURTER_SPEC,
  NASA_APOD_SPEC,
} from './specs/index.ts';

export const OPEN_METEO_CAPABILITY = importCuratedService(OPEN_METEO_SPEC).operations[0]!.capability;
export const NAGER_DATE_CAPABILITY = importCuratedService(NAGER_DATE_SPEC).operations[0]!.capability;
export const REST_COUNTRIES_CAPABILITY = importCuratedService(REST_COUNTRIES_SPEC).operations[0]!.capability;
export const TIME_API_CAPABILITY = importCuratedService(TIME_API_SPEC).operations[0]!.capability;
export const ZIPPOPOTAM_CAPABILITY = importCuratedService(ZIPPOPOTAM_SPEC).operations[0]!.capability;
export const FRANKFURTER_CAPABILITY = importCuratedService(FRANKFURTER_SPEC).operations[0]!.capability;
export const NASA_APOD_CAPABILITY = importCuratedService(NASA_APOD_SPEC).operations[0]!.capability;

export const ALL_CURATED_OPERATIONS: CuratedOperation[] = CURATED_SPECS.flatMap(spec => importCuratedService(spec).operations);
export const ALL_CURATED_CAPABILITIES = ALL_CURATED_OPERATIONS.map(operation => operation.capability);
