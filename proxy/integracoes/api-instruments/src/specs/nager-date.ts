/**
 * Nager.Date Public Holidays API Specification (OpenAPI 3.0 subset)
 * Consulted: 2026-09-17
 * Code license: MIT
 * Hosted data licence: unknown; service terms are distinct from the MIT code.
 */
export const NAGER_DATE_SPEC = {
  openapi: '3.0.3',
  info: {
    title: 'Nager.Date Worldwide Public Holidays API',
    version: '1.0.0',
    description: 'Public holidays worldwide by country and year without registration.',
    'x-uptokey-metadata': {
      serviceId: 'nager_date',
      domain: 'holidays_calendar',
      officialUrl: 'https://date.nager.at',
      specUrl: 'https://date.nager.at/swagger/v1/swagger.json',
      revision: '2026.09.17',
      codeLicense: 'MIT',
      dataLicense: 'unknown',
      commercialTerms: 'Private/non-profit use; commercial use requires active sponsorship; own holiday portals prohibited. https://nagerholidays.com/legal/termsofservice',
      authentication: 'none',
      rateLimit: null,
      attribution: 'Data provided by Nager.Date',
      consultedAt: '2026-09-18T00:00:00.000Z',
    },
  },
  servers: [
    {
      url: 'https://date.nager.at',
      description: 'Production holidays server',
    },
  ],
  paths: {
    '/api/v3/PublicHolidays/{year}/{countryCode}': {
      get: {
        operationId: 'get_public_holidays',
        summary: 'Consultar feriados públicos por ano e país',
        description: 'Retorna a lista de feriados nacionais e bancários para um país e ano especificados.',
        parameters: [
          {
            name: 'year',
            in: 'path',
            required: true,
            description: 'Ano civil com 4 dígitos (ex: 2026)',
            schema: {
              type: 'integer',
              minimum: 1970,
              maximum: 2099,
            },
          },
          {
            name: 'countryCode',
            in: 'path',
            required: true,
            description: 'Código de país ISO 3166-1 alfa-2 com 2 letras maiúsculas (ex: BR, US, JP)',
            schema: {
              type: 'string',
              minLength: 2,
              maxLength: 2,
              enum: ['BR', 'US', 'GB', 'DE', 'FR', 'IT', 'ES', 'JP', 'CA', 'AU', 'PT', 'AR', 'MX'],
            },
          },
        ],
        responses: {
          '200': {
            description: 'Lista de feriados obtida com sucesso',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['date', 'localName', 'name', 'countryCode'],
                    properties: {
                      date: { type: 'string' },
                      localName: { type: 'string' },
                      name: { type: 'string' },
                      countryCode: { type: 'string' },
                      fixed: { type: 'boolean' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/v3/IsTodayPublicHoliday/{countryCode}': {
      get: {
        operationId: 'get_is_today_public_holiday',
        'x-uptokey-status-result': { '200': { isPublicHoliday: true }, '204': { isPublicHoliday: false } },
        summary: 'Verificar se hoje é feriado público no país',
        description: 'Verifica se a data atual corresponde a um feriado público no país especificado.',
        parameters: [
          {
            name: 'countryCode',
            in: 'path',
            required: true,
            description: 'Código de país ISO 3166-1 alfa-2 (ex: BR, US, DE)',
            schema: {
              type: 'string',
              minLength: 2,
              maxLength: 2,
              enum: ['BR', 'US', 'GB', 'DE', 'FR', 'IT', 'ES', 'JP', 'CA', 'AU', 'PT', 'AR', 'MX'],
            },
          },
        ],
        responses: {
          '200': {
            description: 'Hoje é feriado no país',
          },
          '204': {
            description: 'Hoje não é feriado no país',
          },
        },
      },
    },
    '/api/v3/LongWeekend/{year}/{countryCode}': {
      get: {
        operationId: 'get_long_weekends',
        summary: 'Consultar fins de semana prolongados e feriadões',
        description: 'Retorna períodos de fins de semana prolongados devido a feriados adjacentes.',
        parameters: [
          {
            name: 'year',
            in: 'path',
            required: true,
            description: 'Ano civil com 4 dígitos (ex: 2026)',
            schema: {
              type: 'integer',
              minimum: 1970,
              maximum: 2099,
            },
          },
          {
            name: 'countryCode',
            in: 'path',
            required: true,
            description: 'Código de país ISO 3166-1 alfa-2 (ex: BR, US, PT)',
            schema: {
              type: 'string',
              minLength: 2,
              maxLength: 2,
              enum: ['BR', 'US', 'GB', 'DE', 'FR', 'IT', 'ES', 'JP', 'CA', 'AU', 'PT', 'AR', 'MX'],
            },
          },
        ],
        responses: {
          '200': {
            description: 'Lista de fins de semana prolongados',
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
