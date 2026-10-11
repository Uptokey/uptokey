/**
 * Open-Meteo Weather API Specification (OpenAPI 3.0 subset)
 * Consulted: 2026-09-17
 * Code license: AGPL-3.0-only
 * Data license: CC-BY-4.0
 */
export const OPEN_METEO_SPEC = {
  openapi: '3.0.3',
  info: {
    title: 'Open-Meteo Weather Forecast API',
    version: '1.0.0',
    description: 'Accurate global weather forecasts and meteorological conditions without API keys.',
    'x-uptokey-metadata': {
      serviceId: 'open_meteo',
      domain: 'weather_climate',
      officialUrl: 'https://open-meteo.com',
      specUrl: 'https://open-meteo.com/en/docs',
      revision: '2026.09.17',
      codeLicense: 'AGPL-3.0-only',
      dataLicense: 'CC-BY-4.0',
      commercialTerms: 'Free endpoint is non-commercial only; commercial products need a subscription. Data attribution required. https://open-meteo.com/en/terms',
      authentication: 'none',
      rateLimit: '10,000 requests/day, 5,000/hour, 600/minute',
      attribution: 'Weather data by Open-Meteo.com',
      consultedAt: '2026-09-18T00:00:00.000Z',
    },
  },
  servers: [
    {
      url: 'https://api.open-meteo.com',
      description: 'Production forecast server',
    },
  ],
  paths: {
    '/v1/forecast': {
      get: {
        operationId: 'get_weather_forecast',
        summary: 'Obter previsão meteorológica',
        description: 'Consulta temperatura atual, umidade, condições e previsão horária por latitude e longitude.',
        parameters: [
          {
            name: 'latitude',
            in: 'query',
            required: true,
            description: 'Latitude geográfica em graus decimais (-90 a 90)',
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
            description: 'Longitude geográfica em graus decimais (-180 a 180)',
            schema: {
              type: 'number',
              minimum: -180,
              maximum: 180,
            },
          },
          {
            name: 'current',
            in: 'query',
            required: false,
            description: 'Variáveis meteorológicas atuais a retornar',
            schema: {
              type: 'string',
              enum: [
                'temperature_2m',
                'relative_humidity_2m',
                'weather_code',
                'wind_speed_10m',
                'temperature_2m,relative_humidity_2m,weather_code',
              ],
              default: 'temperature_2m',
            },
          },
          {
            name: 'timezone',
            in: 'query',
            required: false,
            description: 'Fuso horário das previsões meteorológicas (ex: America/Sao_Paulo ou UTC)',
            schema: {
              type: 'string',
              maxLength: 64,
            },
          },
          {
            name: 'temperature_unit',
            in: 'query',
            required: false,
            description: 'Unidade de temperatura (celsius ou fahrenheit)',
            schema: {
              type: 'string',
              enum: ['celsius', 'fahrenheit'],
              default: 'celsius',
            },
          },
          {
            name: 'wind_speed_unit',
            in: 'query',
            required: false,
            description: 'Unidade de velocidade do vento (kmh, ms, mph, kn)',
            schema: {
              type: 'string',
              enum: ['kmh', 'ms', 'mph', 'kn'],
              default: 'kmh',
            },
          },
        ],
        responses: {
          '200': {
            description: 'Previsão do tempo obtida com sucesso',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['latitude', 'longitude'],
                  properties: {
                    latitude: { type: 'number' },
                    longitude: { type: 'number' },
                    current: { type: 'object' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/v1/elevation': {
      get: {
        operationId: 'get_ground_elevation',
        summary: 'Consultar elevação e altitude do terreno',
        description: 'Retorna a elevação do solo em metros acima do nível do mar para coordenadas de latitude e longitude.',
        parameters: [
          {
            name: 'latitude',
            in: 'query',
            required: true,
            description: 'Latitude geográfica em graus decimais (-90 a 90)',
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
            description: 'Longitude geográfica em graus decimais (-180 a 180)',
            schema: {
              type: 'number',
              minimum: -180,
              maximum: 180,
            },
          },
        ],
        responses: {
          '200': {
            description: 'Elevação retornada com sucesso',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['elevation'],
                  properties: {
                    elevation: { type: 'array' },
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
