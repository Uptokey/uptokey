/**
 * TimeAPI World Clock & Timezone API Specification (OpenAPI 3.0 subset)
 * Consulted: 2026-09-17
 * Hosted code/data licence: unknown; IANA data does not license this service.
 */
export const TIME_API_SPEC = {
  openapi: '3.0.3',
  info: {
    title: 'TimeAPI World Time and Timezone Conversion API',
    version: '1.0.0',
    description: 'Accurate time zone information and geographic time conversion.',
    'x-uptokey-metadata': {
      serviceId: 'time_api',
      domain: 'timezones_clock',
      officialUrl: 'https://timeapi.io',
      specUrl: 'https://timeapi.io/swagger/index.html',
      revision: '2026.09.17',
      codeLicense: 'unknown',
      dataLicense: 'unknown',
      commercialTerms: 'FAQ says currently free for everyone; detailed commercial/retention terms unknown. https://timeapi.io/home/faqs',
      authentication: 'none',
      rateLimit: null,
      attribution: 'Time data provided by TimeAPI.io',
      consultedAt: '2026-09-18T00:00:00.000Z',
    },
  },
  servers: [
    {
      url: 'https://timeapi.io',
      description: 'Production TimeAPI server',
    },
  ],
  paths: {
    '/api/time/current/zone': {
      get: {
        operationId: 'get_current_time_zone',
        summary: 'Consultar data e hora atual por fuso horário IANA',
        description: 'Retorna a data, hora, offset UTC e detalhes do fuso horário para um identificador IANA.',
        parameters: [
          {
            name: 'timeZone',
            in: 'query',
            required: true,
            description: 'Nome canônico do fuso horário IANA (ex: America/Sao_Paulo, Europe/London, Asia/Tokyo)',
            schema: {
              type: 'string',
              minLength: 3,
              maxLength: 64,
            },
          },
        ],
        responses: {
          '200': {
            description: 'Hora atual do fuso obtida com sucesso',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['year', 'month', 'day', 'hour', 'minute', 'timeZone'],
                  properties: {
                    year: { type: 'integer' },
                    month: { type: 'integer' },
                    day: { type: 'integer' },
                    hour: { type: 'integer' },
                    minute: { type: 'integer' },
                    timeZone: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/time/current/coordinate': {
      get: {
        operationId: 'get_time_by_coordinate',
        summary: 'Consultar fuso horário e hora local por coordenadas geográficas',
        description: 'Retorna o fuso horário e a hora local corrente para latitude e longitude informadas.',
        parameters: [
          {
            name: 'latitude',
            in: 'query',
            required: true,
            description: 'Latitude geográfica decimal (-90 a 90)',
            schema: {
              type: 'number',
              minimum: -90,
              maximum: 90,
            },
          },
          {
            name: 'longitude',
            in: 'query',
            required: true,
            description: 'Longitude geográfica decimal (-180 a 180)',
            schema: {
              type: 'number',
              minimum: -180,
              maximum: 180,
            },
          },
        ],
        responses: {
          '200': {
            description: 'Fuso e hora local por coordenadas',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['timeZone'],
                  properties: {
                    timeZone: { type: 'string' },
                    dateTime: { type: 'string' },
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
