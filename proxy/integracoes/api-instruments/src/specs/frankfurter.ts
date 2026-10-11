/**
 * Frankfurter Reference Currency API Specification (OpenAPI 3.0 subset)
 * Consulted: 2026-09-17
 * Code license: MIT
 * Data rights depend on the source bank; hosted retention/redistribution terms unverified.
 */
export const FRANKFURTER_SPEC = {
  openapi: '3.0.3',
  info: {
    title: 'Frankfurter Reference Exchange Rates API',
    version: '1.0.0',
    description: 'Track foreign exchange reference rates published by the European Central Bank without API keys.',
    'x-uptokey-metadata': {
      serviceId: 'frankfurter',
      domain: 'currency_exchange',
      officialUrl: 'https://frankfurter.dev',
      specUrl: 'https://frankfurter.dev/v1/',
      revision: '2026.09.17',
      codeLicense: 'MIT',
      dataLicense: 'unknown; source-bank terms apply',
      commercialTerms: 'Public API without key; v1 deprecated but documented as continuing. Detailed hosted commercial/retention terms unknown. https://frankfurter.dev/v1/',
      authentication: 'none',
      rateLimit: null,
      attribution: 'Exchange rate data from the European Central Bank via Frankfurter',
      consultedAt: '2026-09-18T00:00:00.000Z',
    },
  },
  servers: [
    {
      url: 'https://api.frankfurter.dev',
      description: 'Production Frankfurter API server',
    },
  ],
  paths: {
    '/v1/latest': {
      get: {
        operationId: 'get_latest_exchange_rates',
        summary: 'Consultar cotações e taxas de câmbio mais recentes do BCE',
        description: 'Retorna as taxas de conversão cambial atualizadas publicadas pelo Banco Central Europeu.',
        parameters: [
          {
            name: 'base',
            in: 'query',
            required: false,
            description: 'Moeda base de referência (ex: USD, EUR, BRL, JPY, GBP)',
            schema: {
              type: 'string',
              minLength: 3,
              maxLength: 3,
              default: 'EUR',
            },
          },
          {
            name: 'symbols',
            in: 'query',
            required: false,
            description: 'Códigos das moedas alvo separadas por vírgula (ex: BRL,USD,GBP)',
            schema: {
              type: 'string',
              minLength: 3,
              maxLength: 64,
            },
          },
        ],
        responses: {
          '200': {
            description: 'Cotações cambiais obtidas com sucesso',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['amount', 'base', 'date', 'rates'],
                  properties: {
                    amount: { type: 'number' },
                    base: { type: 'string' },
                    date: { type: 'string' },
                    rates: { type: 'object' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/v1/{date}': {
      get: {
        operationId: 'get_historical_exchange_rates',
        summary: 'Consultar taxas de câmbio históricas em uma data específica',
        description: 'Retorna a taxa de câmbio oficial do BCE na data histórica solicitada.',
        parameters: [
          {
            name: 'date',
            in: 'path',
            required: true,
            description: 'Data histórica no formato AAAA-MM-DD (ex: 2026-01-02)',
            schema: {
              type: 'string',
              format: 'date',
              minLength: 10,
              maxLength: 10,
            },
          },
          {
            name: 'base',
            in: 'query',
            required: false,
            description: 'Moeda base de referência (ex: USD, EUR, BRL)',
            schema: {
              type: 'string',
              minLength: 3,
              maxLength: 3,
            },
          },
        ],
        responses: {
          '200': {
            description: 'Cotações históricas obtidas com sucesso',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['base', 'date', 'rates'],
                  properties: {
                    base: { type: 'string' },
                    date: { type: 'string' },
                    rates: { type: 'object' },
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
