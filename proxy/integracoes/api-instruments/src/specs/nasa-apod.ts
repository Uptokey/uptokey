/**
 * NASA APOD (Astronomy Picture of the Day) — leitura pública sem cadastro.
 * A NASA documenta o DEMO_KEY público (api.nasa.gov) como chave de uso imediato,
 * limitada a 30 req/h por IP e 50 req/dia; chave própria eleva os limites.
 * Consultado: 2026-09-30 (https://api.nasa.gov/).
 */
export const NASA_APOD_SPEC = {
  openapi: '3.0.3',
  info: {
    title: 'NASA APOD (Astronomy Picture of the Day)',
    version: '1.0.0',
    'x-uptokey-metadata': {
      serviceId: 'nasa',
      domain: 'space_science',
      officialUrl: 'https://api.nasa.gov',
      specUrl: 'https://api.nasa.gov/',
      revision: '2026.09.30',
      codeLicense: 'HTTP service; no upstream code copied',
      dataLicense: 'NASA content: U.S. Government work (public domain) unless the caption attributes another author',
      commercialTerms: 'DEMO_KEY is the documented public key (30 req/h per IP, 50/day); a personal key raises the limits. Third-party images credited in the response keep their authors\' rights.',
      authentication: 'none',
      rateLimit: 'DEMO_KEY: 30 requests/hour per IP, 50 requests/day (documented); personal key raises limits',
      attribution: 'NASA / Astronomy Picture of the Day',
      consultedAt: '2026-09-30T00:00:00.000Z',
      contentRights: {
        termsUrl: 'https://www.nasa.gov/nasa-brand-center/images-and-media-guidelines/',
        verifiedAt: '2026-09-30',
        permissions: { obtain: true, store: true, display: true, export: true, model_input: true, train: 'unknown' },
      },
    },
  },
  servers: [{ url: 'https://api.nasa.gov' }],
  paths: {
    '/planetary/apod': {
      get: {
        operationId: 'get_apod',
        summary: 'Imagem astronômica do dia',
        description: 'Título, data, explicação e URL da imagem do dia. Sem cadastro (DEMO_KEY público) ou com chave própria para limites maiores. Uma consulta por etapa aprovada.',
        parameters: [
          { name: 'api_key', in: 'query', required: false, description: 'Public demo credential. Personal credentials belong in a configured account.', schema: { type: 'string', enum: ['DEMO_KEY'], default: 'DEMO_KEY' } },
          { name: 'date', in: 'query', required: false, description: 'Data no formato AAAA-MM-DD; sem data, a imagem mais recente', schema: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } },
        ],
        responses: { '200': { description: 'Public JSON response' } },
      },
    },
  },
} as const;
