export const TYPESAFE_SPEC = {
  openapi: '3.0.3',
  info: {
    title: 'TypeSafe SystemOne API',
    version: '1.0.0',
    description: 'Resolves user intent to available API operations',
    'x-uptokey-metadata': {
      serviceId: 'typesafe_intent',
      domain: 'platform',
      officialUrl: 'https://typesafe.ai',
      specUrl: '',
      revision: '1.0',
      codeLicense: 'Proprietary',
      dataLicense: 'Proprietary',
      commercialTerms: 'Internal Use',
      authentication: 'Sentinel Key',
      rateLimit: null,
      attribution: 'TypeSafe AI',
      consultedAt: new Date().toISOString()
    },
  },
  servers: [
    {
      url: 'https://api.typesafe.ai',
      description: 'Production server',
    },
  ],
  paths: {
    '/v1/systemOne': {
      get: {
        operationId: 'typesafe_intent_route',
        summary: 'Semantic Intent Routing',
        description: 'Resolves user intent to available API operations',
        parameters: [
          {
            name: 'userPhrase',
            in: 'query',
            required: true,
            description: 'User input text',
            schema: { type: 'string' }
          }
        ],
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    matched: { type: 'boolean' },
                    operationId: { type: 'string', nullable: true },
                    confidence: { type: 'number' },
                  }
                }
              }
            }
          }
        }
      }
    }
  }
};
