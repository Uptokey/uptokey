/**
 * Zippopotam.us Postal Code API Specification (OpenAPI 3.0 subset)
 * Consulted: 2026-09-17
 * Code licence: unknown. API database: ODbL-1.0; individual contents: DbCL-1.0.
 */
export const ZIPPOPOTAM_SPEC = {
  openapi: '3.0.3',
  info: {
    title: 'Zippopotam.us Postal Code and Geography API',
    version: '1.0.0',
    description: 'Lookup location, places, states, and coordinates from postal codes worldwide without API keys.',
    'x-uptokey-metadata': {
      serviceId: 'zippopotam',
      domain: 'postal_locations',
      officialUrl: 'https://api.zippopotam.us',
      specUrl: 'https://api.zippopotam.us',
      revision: '2026.09.17',
      codeLicense: 'unknown',
      dataLicense: 'ODbL-1.0 / DbCL-1.0',
      commercialTerms: 'API database under ODbL and contents under DbCL; hosted commercial limits unknown. https://api.zippopotam.us/',
      authentication: 'none',
      rateLimit: null,
      attribution: 'Postal data by Zippopotam.us and GeoNames',
      consultedAt: '2026-09-18T00:00:00.000Z',
    },
  },
  servers: [
    {
      url: 'https://api.zippopotam.us',
      description: 'Production Zippopotam server',
    },
  ],
  paths: {
    '/{country}/{postalcode}': {
      get: {
        operationId: 'get_postal_location',
        summary: 'Consultar localidade, estado e coordenadas por CEP / código postal',
        description: 'Retorna a cidade, estado, latitude e longitude associadas a um código postal e país.',
        parameters: [
          {
            name: 'country',
            in: 'path',
            required: true,
            description: 'Código de país ISO 3166-1 alfa-2 em minúsculas (ex: us, br, de, fr)',
            schema: {
              type: 'string',
              minLength: 2,
              maxLength: 2,
            },
          },
          {
            name: 'postalcode',
            in: 'path',
            required: true,
            description: 'Código postal ou CEP (ex: 90210, 01000-000, 75008)',
            schema: {
              type: 'string',
              minLength: 2,
              maxLength: 16,
            },
          },
        ],
        responses: {
          '200': {
            description: 'Localização do CEP obtida com sucesso',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['post code', 'country', 'places'],
                  properties: {
                    'post code': { type: 'string' },
                    country: { type: 'string' },
                    places: { type: 'array' },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
} as const;
