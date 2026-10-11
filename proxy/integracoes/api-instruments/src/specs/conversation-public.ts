/** Selected DC2 reads adapted from src_delivery's GitHub/PokéAPI/World Bank adapters.
 * Only URL/schema metadata is reused: effects remain in the existing W5 dispatcher.
 * Primary endpoint documentation checked 2026-09-18; no account or live request required.
 */
const consultedAt = '2026-09-18T00:00:00.000Z';
const response = { '200': { description: 'Public JSON response' } };
const pageParameters = [
  { name: 'page', in: 'query', required: false, description: 'One explicit page; no automatic traversal', schema: { type: 'integer', minimum: 1, maximum: 10000, default: 1 } },
  { name: 'per_page', in: 'query', required: true, description: 'Maximum records on the requested page', schema: { type: 'integer', minimum: 1, maximum: 30, default: 10 } },
] as const;
const githubParameters = [
  { name: 'owner', in: 'path', required: true, description: 'Public repository owner', schema: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9-]{0,38}$', maxLength: 39 } },
  { name: 'repo', in: 'path', required: true, description: 'Public repository name', schema: { type: 'string', pattern: '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$', maxLength: 100 } },
  { name: 'state', in: 'query', required: false, description: 'Issue or pull request state', schema: { type: 'string', enum: ['open', 'closed', 'all'], default: 'open' } },
  ...pageParameters,
] as const;

export const GITHUB_PUBLIC_SPEC = {
  openapi: '3.0.3',
  info: { title: 'GitHub public repository reads', version: '1.0.0', 'x-uptokey-metadata': {
    serviceId: 'github_public', domain: 'software_development', officialUrl: 'https://docs.github.com/en/rest',
    specUrl: 'https://docs.github.com/en/rest/issues/issues#list-repository-issues', revision: '2026.09.18',
    codeLicense: 'HTTP service; no GitHub implementation copied', dataLicense: 'Repository and content rights apply; redistribution rights unknown',
    commercialTerms: 'Public resources only, without a token. This catalog does not grant content redistribution rights.',
    authentication: 'none', rateLimit: 'GitHub unauthenticated and secondary limits apply; 403/429 are not retried internally.',
    attribution: 'GitHub and the source repository contributors', consultedAt,
  } },
  servers: [{ url: 'https://api.github.com' }],
  paths: {
    '/repos/{owner}/{repo}/issues': { get: { operationId: 'get_public_repository_issues', summary: 'Consultar issues e pull requests de um repositório público', description: 'Uma página do endpoint issues; inclui itens pull_request identificados pela fonte. Não filtra nem promete cobertura completa.', parameters: githubParameters, responses: response } },
    '/repos/{owner}/{repo}/pulls': { get: { operationId: 'get_public_repository_pulls', summary: 'Consultar pull requests de um repositório público', description: 'Uma página de pull requests, sem autenticação, escrita ou download de arquivos.', parameters: githubParameters, responses: response } },
  },
} as const;

export const POKEAPI_SPEC = {
  openapi: '3.0.3',
  info: { title: 'PokéAPI', version: '1.0.0', 'x-uptokey-metadata': {
    serviceId: 'pokeapi', domain: 'games_entertainment', officialUrl: 'https://pokeapi.co', specUrl: 'https://pokeapi.co/docs/v2', revision: '2026.09.18',
    codeLicense: 'HTTP service; no upstream code copied', dataLicense: 'Pokémon content rights are separate from API access; redistribution unknown',
    commercialTerms: 'Educational public API with fair use policy. Existing local provenance cache is used; API access does not grant trademark or artwork rights.',
    authentication: 'none', rateLimit: 'Cache responses and limit request frequency under the documented fair use policy.', attribution: 'PokéAPI; Pokémon content belongs to its respective rights holders', consultedAt,
  } },
  servers: [{ url: 'https://pokeapi.co' }],
  paths: { '/api/v2/pokemon/{name}/': { get: {
    operationId: 'get_pokemon', summary: 'Consultar um Pokémon por nome ou número', description: 'Consulta uma entidade. Mantém altura em decímetros e peso em hectogramas; não baixa imagens ou recursos ligados.',
    parameters: [{ name: 'name', in: 'path', required: true, description: 'Lowercase resource name or numeric identifier', schema: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,99}$', maxLength: 100 } }], responses: response,
  } } },
} as const;

export const WORLD_BANK_SPEC = {
  openapi: '3.0.3',
  info: { title: 'World Bank indicators', version: '1.0.0', 'x-uptokey-metadata': {
    serviceId: 'world_bank', domain: 'economy_indicators', officialUrl: 'https://data.worldbank.org',
    specUrl: 'https://datahelpdesk.worldbank.org/knowledgebase/articles/898581-api-basic-call-structures', revision: '2026.09.18',
    codeLicense: 'HTTP service; no upstream code copied', dataLicense: 'Dataset-specific terms apply; consult the source indicator',
    commercialTerms: 'Rights and attribution must be checked for the selected dataset. Missing values remain null; a requested page is not an exhaustive dataset.',
    authentication: 'none', rateLimit: 'No unlimited quota asserted; one bounded request per approved step.', attribution: 'World Bank and the dataset source', consultedAt,
  } },
  servers: [{ url: 'https://api.worldbank.org' }],
  paths: { '/v2/country/{country}/indicator/{indicator}': { get: {
    operationId: 'get_country_indicator', summary: 'Consultar indicador econômico por país', description: 'Uma página com metadados de paginação e observações; não preenche valores ausentes nem inventa datas completas a partir de anos.',
    parameters: [
      { name: 'country', in: 'path', required: true, description: 'Single country ISO code', schema: { type: 'string', pattern: '^[A-Za-z]{2,3}$', maxLength: 3 } },
      { name: 'indicator', in: 'path', required: true, description: 'Indicator identifier, for example SP.POP.TOTL', schema: { type: 'string', pattern: '^[A-Z0-9][A-Z0-9_.]{0,79}$', maxLength: 80 } },
      { name: 'format', in: 'query', required: true, description: 'JSON only', schema: { type: 'string', enum: ['json'], default: 'json' } },
      ...pageParameters,
    ], responses: response,
  } } },
} as const;
