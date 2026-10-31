import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { RequestError } from 'proxy-chain';
import { publicBrowserUrl } from './playwright-policy.mjs';

const normalizeHost = host => host.replace(/^\[|\]$/g, '').toLowerCase();
const hostUrl = (host, port, isHttp) => `${isHttp ? 'http' : 'https'}://${isIP(normalizeHost(host)) === 6 ? `[${normalizeHost(host)}]` : host}:${port}/`;
const blocked = () => new RequestError('Private network destinations are outside the public egress scope.', 403);

/** The existing proxy-chain dialer consumes this lookup directly, for HTTP and CONNECT. */
export function createPublicEgressPolicy({ allowedOrigin, resolveHost = lookup } = {}) {
  return async ({ hostname, port, isHttp }) => {
    const target = hostUrl(hostname, port, isHttp);
    if (publicBrowserUrl(target, allowedOrigin)) throw blocked();
    const host = normalizeHost(hostname);
    const allowedFixture = allowedOrigin && new URL(target).origin === allowedOrigin;
    const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolveHost(host, { all: true, verbatim: true });
    if (!addresses.length || !allowedFixture && addresses.some(({ address }) => publicBrowserUrl(hostUrl(address, port, isHttp)))) throw blocked();
    // No second DNS resolution occurs between validation and the actual socket.
    // Do not share an agent socket selected under an earlier request's DNS result.
    return { httpAgent: false, httpsAgent: false, dnsLookup(requestedHost, options, callback) {
      if (typeof options === 'function') { callback = options; options = {}; }
      if (normalizeHost(requestedHost) !== host) return callback(blocked());
      const family = typeof options === 'number' ? options : options?.family;
      const pinned = addresses.filter(item => !family || item.family === family);
      if (!pinned.length) return callback(blocked());
      if (options?.all) callback(null, pinned.map(item => ({ ...item })));
      else callback(null, pinned[0].address, pinned[0].family);
    } };
  };
}
