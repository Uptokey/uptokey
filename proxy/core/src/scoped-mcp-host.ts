import {createServer, type IncomingMessage} from 'node:http';
import {randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {InitializeRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';

export interface ScopedMcpSession {
  server: {connect(transport: Transport): Promise<void>};
  close(): Promise<void>;
}

/** A host-owned session capability, never an admin token or a provider key.
 * Each factory binds tools to host-owned authority. This transport authenticates
 * and expires that capability; it never expands tool authority.
 */
export async function createScopedMcpHost(
  createSession: (authorize: () => Promise<boolean>) => ScopedMcpSession,
  options: {authorize: () => Promise<boolean>},
) {
  let token = randomBytes(32).toString('base64url');
  let authorization = Buffer.from(`Bearer ${token}`);
  let generation = 0;
  const sessions = new Map<string, ScopedMcpSession>();
  const transports = new Map<string, StreamableHTTPServerTransport>();
  let closed = false;
  let host = '';
  const admitted = async () => !closed && await options.authorize() && !closed;
  const authenticated = (request: IncomingMessage) => {
    const given = Buffer.from(request.headers.authorization ?? '');
    return given.length === authorization.length && timingSafeEqual(given, authorization);
  };
  const server = createServer(async (request, response) => {
    const reject = (status: number) => {response.writeHead(status, {'content-type': 'application/json', 'cache-control': 'no-store'}); response.end('{"error":"task_session_unavailable"}');};
    try {
      if (closed || request.url !== '/mcp' || request.headers.host !== host || request.headers.origin !== undefined) return reject(403);
      if (!authenticated(request) || !await admitted()) return reject(401);
      const requestGeneration = generation;
      if (!['POST', 'GET', 'DELETE'].includes(request.method ?? '')) return reject(405);
      let body: unknown;
      if (request.method === 'POST') {
        if (!request.headers['content-type']?.startsWith('application/json')) return reject(415);
        const chunks: Buffer[] = []; let length = 0;
        for await (const chunk of request) {
          const bytes = Buffer.from(chunk); length += bytes.length;
          if (length > 64 * 1024) return reject(413);
          chunks.push(bytes);
        }
        try {body = JSON.parse(Buffer.concat(chunks).toString('utf8'));} catch {return reject(400);}
        if (Array.isArray(body)) return reject(400);
      }
      const sessionId = request.headers['mcp-session-id'];
      if (!await admitted() || requestGeneration !== generation || !authenticated(request)) return reject(401);
      let transport = typeof sessionId === 'string' ? transports.get(sessionId) : undefined;
      let allocated: {id: string; owner: ScopedMcpSession} | undefined;
      if (!transport) {
        if (sessionId !== undefined || request.method !== 'POST' || !body || typeof body !== 'object' || !('method' in body) || body.method !== 'initialize') return reject(404);
        if (!InitializeRequestSchema.safeParse(body).success) return reject(400);
        if (sessions.size >= 2) return reject(429);
        // Initialize allocation is synchronous before the first await, preventing
        // concurrent initializations from bypassing the per-host session ceiling.
        const id = randomUUID();
        const owner = createSession(async () => requestGeneration === generation && await admitted() && requestGeneration === generation);
        allocated = {id, owner};
        transport = new StreamableHTTPServerTransport({sessionIdGenerator: () => id, enableJsonResponse: true});
        sessions.set(id, owner); transports.set(id, transport);
        transport.onclose = () => {sessions.delete(id); transports.delete(id);};
        try {await owner.server.connect(transport);} catch {sessions.delete(id); transports.delete(id); await owner.close(); return reject(500);}
      }
      if (!await admitted() || requestGeneration !== generation || !authenticated(request)) {
        if (allocated && sessions.get(allocated.id) === allocated.owner) {
          sessions.delete(allocated.id); transports.delete(allocated.id);
          await allocated.owner.close();
        }
        return reject(401);
      }
      await transport.handleRequest(request, response, body);
    } catch {if (!response.headersSent) reject(500); else response.end();}
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 32;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {server.off('error', reject); resolve();});
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('task_session_unavailable');
  host = `127.0.0.1:${address.port}`;
  return {
    url: `http://${host}/mcp`, get token() {return token;},
    /** The host calls this after stopping an engine before restarting its ACP
     * process. Old MCP sessions/tokens cannot survive into the new process. */
    async renew() {
      if (closed || !await admitted()) throw Error('task_session_unavailable');
      generation++;
      token = randomBytes(32).toString('base64url');
      authorization = Buffer.from(`Bearer ${token}`);
      const previous = [...sessions.values()];
      sessions.clear(); transports.clear();
      await Promise.allSettled(previous.map(owner => owner.close()));
      return token;
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.allSettled([...sessions.values()].map(owner => owner.close()));
      sessions.clear(); transports.clear();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
