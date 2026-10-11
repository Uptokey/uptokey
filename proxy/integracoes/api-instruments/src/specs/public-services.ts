/** Public read contracts from the linked publishers' documentation, reviewed 2026-10-06.
 * These definitions enter the existing governed executor; they do not fetch during startup.
 * Access to an API never implies rights to redistribute its artwork or underlying data.
 */
type Parameter = {
  name: string; in: 'query' | 'path'; required: boolean; description: string;
  schema: Record<string, unknown>;
};
const query = (name: string, schema: Record<string, unknown>, required = false): Parameter =>
  ({name, in: 'query', required, description: name, schema});
const path = (name: string, schema: Record<string, unknown>): Parameter =>
  ({name, in: 'path', required: true, description: name, schema});
const text = {type: 'string', minLength: 1, maxLength: 200};
const get = (operationId: string, summary: string, parameters: Parameter[] = []) => ({get: {
  operationId, summary, description: summary, parameters,
  responses: {'200': {description: 'Public JSON response'}},
}});
function service(serviceId: string, title: string, origin: string, documentation: string,
  paths: Record<string, ReturnType<typeof get>>, terms = 'Publisher terms and source-content rights apply.') {
  return {
    openapi: '3.0.3', info: {title, version: '1.0.0', 'x-uptokey-metadata': {
      serviceId, domain: 'public_data', officialUrl: documentation, specUrl: documentation,
      revision: '2026.10.06', codeLicense: 'HTTP contract; no upstream implementation copied',
      dataLicense: terms, commercialTerms: terms, authentication: 'none',
      rateLimit: 'Publisher limits apply; one bounded request per action, no automatic traversal.',
      attribution: title, consultedAt: '2026-10-06T00:00:00.000Z',
    }}, servers: [{url: origin}], security: [], paths,
  };
}

/** One registry feeds operations, capabilities, origins and service discovery. */
export const PUBLIC_SERVICE_SPECS = [
  service('jsonplaceholder', 'JSONPlaceholder', 'https://jsonplaceholder.typicode.com', 'https://jsonplaceholder.typicode.com/guide/', {
    '/posts': get('list_posts', 'Read example posts', [query('userId', {type: 'integer', minimum: 1, maximum: 10})]),
    '/posts/{id}': get('get_post', 'Read an example post', [path('id', {type: 'integer', minimum: 1, maximum: 100})]),
  }, 'Public demonstration data. Write requests are simulated by the publisher and are not offered as persistent operations.'),
  service('dog_ceo', 'Dog CEO', 'https://dog.ceo', 'https://dog.ceo/dog-api/documentation/', {
    '/api/breeds/list/all': get('list_breeds', 'List dog breeds'),
    '/api/breeds/image/random': get('random_image', 'Get a dog image URL'),
  }),
  service('meowfacts', 'MeowFacts', 'https://meowfacts.herokuapp.com', 'https://github.com/wh-iterabb-it/meowfacts', {
    '/': get('get_facts', 'Get cat facts', [query('count', {type: 'integer', minimum: 1, maximum: 10, default: 1}),
      query('lang', {type: 'string', enum: ['eng-us', 'por-br', 'esp-es', 'ger-de', 'ita-it', 'kor-ko', 'zho-tw'], default: 'eng-us'})]),
  }),
  service('hacker_news', 'Hacker News', 'https://hacker-news.firebaseio.com', 'https://github.com/HackerNews/API', {
    '/v0/topstories.json': get('top_stories', 'Get top story IDs'),
    '/v0/item/{id}.json': get('get_item', 'Get a story or comment', [path('id', {type: 'integer', minimum: 1, maximum: 2147483647})]),
  }),
  service('sunrise_sunset', 'Sunrise Sunset', 'https://api.sunrise-sunset.org', 'https://sunrise-sunset.org/api', {
    '/json': get('sun_times', 'Get sunrise and sunset times', [
      query('lat', {type: 'number', minimum: -90, maximum: 90}, true),
      query('lng', {type: 'number', minimum: -180, maximum: 180}, true),
      query('date', {type: 'string', pattern: '^([0-9]{4}-[0-9]{2}-[0-9]{2}|today)$', default: 'today'}),
      query('formatted', {type: 'integer', enum: [0], default: 0}, true),
    ]),
  }, 'Attribution to sunrise-sunset.org is required: https://sunrise-sunset.org/api'),
  service('usgs_earthquakes', 'USGS Earthquakes', 'https://earthquake.usgs.gov', 'https://earthquake.usgs.gov/fdsnws/event/1/', {
    '/fdsnws/event/1/query': get('search_earthquakes', 'Find earthquakes', [
      query('format', {type: 'string', enum: ['geojson'], default: 'geojson'}, true),
      query('limit', {type: 'integer', minimum: 1, maximum: 20, default: 10}, true),
      query('minmagnitude', {type: 'number', minimum: -2, maximum: 10}),
      query('starttime', {type: 'string', format: 'date'}), query('endtime', {type: 'string', format: 'date'}),
    ]),
  }),
  service('tvmaze', 'TVmaze', 'https://api.tvmaze.com', 'https://www.tvmaze.com/api', {
    '/search/shows': get('search_shows', 'Find TV shows', [query('q', text, true)]),
    '/shows/{id}': get('get_show', 'Get a TV show', [path('id', {type: 'integer', minimum: 1, maximum: 2147483647})]),
  }, 'TVmaze API data: CC-BY-SA; attribution and share-alike requirements apply. https://www.tvmaze.com/api#licensing'),
  service('jikan', 'Jikan', 'https://api.jikan.moe', 'https://docs.api.jikan.moe/', {
    '/v4/anime': get('search_anime', 'Find anime', [query('q', text, true),
      query('limit', {type: 'integer', minimum: 1, maximum: 10, default: 5}, true),
      query('sfw', {type: 'boolean', default: true})]),
  }),
  service('gbif', 'GBIF', 'https://api.gbif.org', 'https://techdocs.gbif.org/en/openapi/v1/species', {
    '/v1/species/search': get('search_species', 'Find species', [query('q', text, true),
      query('limit', {type: 'integer', minimum: 1, maximum: 20, default: 10}, true),
      query('offset', {type: 'integer', minimum: 0, maximum: 10000, default: 0})]),
  }, 'Dataset-specific licenses and attribution apply; retain GBIF source references.'),
  service('gutendex', 'Gutendex', 'https://gutendex.com', 'https://gutendex.com/', {
    '/books/': get('find_books', 'Find books', [query('search', text, true),
      query('page', {type: 'integer', minimum: 1, maximum: 10000, default: 1})]),
  }, 'Metadata only. Book copyright depends on jurisdiction; API availability grants no content rights. Long-term users should host their own server.'),
  service('open_trivia', 'Open Trivia DB', 'https://opentdb.com', 'https://opentdb.com/api_config.php', {
    '/api.php': get('get_questions', 'Get trivia questions', [
      query('amount', {type: 'integer', minimum: 1, maximum: 10, default: 5}, true),
      query('type', {type: 'string', enum: ['multiple', 'boolean']}),
      query('difficulty', {type: 'string', enum: ['easy', 'medium', 'hard']}),
      query('encode', {type: 'string', enum: ['url3986'], default: 'url3986'}, true),
    ]),
  }, 'Open Trivia DB content is CC-BY-SA 4.0; attribution and share-alike requirements apply.'),
];

/** Exact catalogue identities only. No fuzzy matching or documentation-host inference. */
export const PUBLIC_SERVICE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  jsonplaceholder: ['public-jsonplaceholder'],
  dog_ceo: ['public-dogs'], meowfacts: ['public-meowfacts'], hacker_news: ['public-hackernews'],
  sunrise_sunset: ['public-sunrise-and-sunset'], usgs_earthquakes: ['public-usgs-earthquake-hazards-program'],
  tvmaze: ['public-tvmaze'], jikan: ['public-jikan'], gbif: ['public-gbif'],
  gutendex: ['public-gutendex'], open_trivia: ['public-open-trivia'],
};
