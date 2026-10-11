/**
 * REST Countries API Specification (OpenAPI 3.0 subset)
 * Consulted: 2026-09-17
 * Current hosted v3.1 code/data terms: unknown; do not infer from an old repository licence.
 */
export const REST_COUNTRIES_SPEC = {
  openapi: '3.0.3',
  info: {
    title: 'REST Countries API',
    version: '1.0.0',
    description: 'Get information about world countries via a RESTful API.',
    'x-uptokey-metadata': {
      serviceId: 'rest_countries',
      domain: 'geography_demographics',
      officialUrl: 'https://restcountries.com',
      specUrl: 'https://gitlab.com/restcountries/restcountries',
      revision: '2026.09.17',
      codeLicense: 'unknown',
      dataLicense: 'unknown',
      commercialTerms: 'unknown for the curated v3.1 endpoint; current official site documents authenticated v5. https://restcountries.com/',
      authentication: 'none',
      rateLimit: null,
      attribution: 'REST Countries API',
      consultedAt: '2026-09-18T00:00:00.000Z',
    },
  },
  servers: [
    {
      url: 'https://restcountries.com',
      description: 'Production REST Countries server',
    },
  ],
  paths: {
    '/v3.1/name/{name}': {
      get: {
        operationId: 'get_country_by_name',
        summary: 'Consultar dados demográficos e geográficos de um país por nome',
        description: 'Retorna capital, população, moedas, idiomas e região geográfica a partir do nome comum ou oficial.',
        parameters: [
          {
            name: 'name',
            in: 'path',
            required: true,
            description: 'Nome do país (ex: Brazil, Japan, Germany)',
            schema: {
              type: 'string',
              minLength: 2,
              maxLength: 100,
            },
          },
          {
            name: 'fields',
            in: 'query',
            required: false,
            description: 'Campos específicos a retornar separados por vírgula (ex: name,capital,currencies)',
            schema: {
              type: 'string',
              maxLength: 256,
            },
          },
        ],
        responses: {
          '200': {
            description: 'Dados demográficos do país encontrados',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                },
              },
            },
          },
        },
      },
    },
    '/v3.1/region/{region}': {
      get: {
        operationId: 'get_countries_by_region',
        summary: 'Listar países por continente ou região geográfica',
        description: 'Retorna países pertencentes a uma região continental especificada.',
        parameters: [
          {
            name: 'region',
            in: 'path',
            required: true,
            description: 'Região continental (ex: Americas, Europe, Asia, Africa, Oceania)',
            schema: {
              type: 'string',
              enum: ['Africa', 'Americas', 'Asia', 'Europe', 'Oceania'],
            },
          },
          {
            name: 'fields',
            in: 'query',
            required: false,
            description: 'Campos específicos a retornar separados por vírgula',
            schema: {
              type: 'string',
              maxLength: 256,
            },
          },
        ],
        responses: {
          '200': {
            description: 'Lista de países da região',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                },
              },
            },
          },
        },
      },
    },
  },
} as const;
