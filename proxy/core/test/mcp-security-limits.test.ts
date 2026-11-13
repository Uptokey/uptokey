import test from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod/v4';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { parseBrowserFillRequest } from '@uptokey/sync-contract/browser';
import { createUptokeyMcpServer, MCP_MAX_TOOL_INPUT_ELEMENTS } from '../src/mcp-server.ts';
import { McpSession, MCP_SCOPES } from '../src/mcp-session.ts';
import type { McpProxyClient } from '../src/mcp-proxy-client.ts';
import { readFile } from 'node:fs/promises';

test('patched Zod array maximum rejects before element parsing', () => {
  let parsed = 0;
  const schema = z.array(z.string().superRefine(() => { parsed++; })).max(2);
  const rejected = schema.safeParse(['a', 'b', 'c']);
  assert.equal(rejected.success, false);
  assert.equal(parsed, 0);
  assert.equal(schema.safeParse(['a', 'b']).success, true);
  assert.equal(parsed, 2);
});

test('MCP browser fields match the existing eight-field contract and include its version', async () => {
  const session = McpSession.forTests({ sessionId: '00000000-0000-4000-8000-000000000001', clientId: '11111111-1111-4111-8111-111111111111', scopes: MCP_SCOPES, expiresAt: new Date(Date.now() + 60_000).toISOString(), proxyOrigin: 'http://127.0.0.1:21435', proxyHost: '127.0.0.1:21435' }, 'synthetic-memory-only');
  let posted = 0;
  const fake = { async postJson(_path: string, body: unknown) {
    const request = (body as { request: unknown }).request;
    const parsed = parseBrowserFillRequest(request);
    assert.equal(parsed.fields.length, 8);
    posted++;
    return { schemaVersion: 1, status: 'awaiting_approval' };
  }} as unknown as McpProxyClient;
  const handles = createUptokeyMcpServer(session, fake);
  const configured = handles.server as unknown as { _maxToolInputElements: number };
  assert.equal(MCP_MAX_TOOL_INPUT_ELEMENTS, 65_536);
  assert.equal(configured._maxToolInputElements, MCP_MAX_TOOL_INPUT_ELEMENTS);
  const client = new Client({ name: 'synthetic-security-fixture', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await handles.server.connect(b); await client.connect(a);
    const args = { projectId: 'fixture', expectedRevision: 1, url: 'http://127.0.0.1:12345/fixture', fields: Array.from({ length: 8 }, (_, index) => ({ label: 'field' + index, value: 'fixture' })) };
    const ok = await client.callTool({ name: 'browser_action_plan', arguments: args });
    assert.ok(!ok.isError); assert.equal(posted, 1);
    const no = await client.callTool({ name: 'browser_action_plan', arguments: { ...args, fields: [...args.fields, { label: 'field8', value: 'fixture' }] } });
    assert.equal(no.isError, true); assert.equal(posted, 1);
  } finally { await client.close(); await handles.close(); }
});

test('SDK structural input budget rejects a tiny nested raw schema before Zod element parsing', async () => {
  const server = new McpServer({ name: 'synthetic-budget', version: '1.0.0' }, { maxToolInputElements: 8 });
  let parsed = 0, executed = 0;
  server.registerTool('fixture', { inputSchema: { raw: z.unknown().superRefine(() => { parsed++; }) } }, () => { executed++; return { content: [] }; });
  const client = new Client({ name: 'synthetic-budget-client', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b); await client.connect(a);
    const rejected = await client.callTool({ name: 'fixture', arguments: { raw: { nested: Array(8).fill(0) } } });
    assert.equal(rejected.isError, true); assert.equal(parsed, 0); assert.equal(executed, 0);
    const accepted = await client.callTool({ name: 'fixture', arguments: { raw: { nested: [0] } } });
    assert.ok(!accepted.isError); assert.equal(parsed, 1); assert.equal(executed, 1);
  } finally { await client.close(); await server.close(); }
});

test('npm manifest generator carries exact patched external dependency versions', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const { packageManifest } = await import(new URL('../scripts/npm-pack-beta.mjs', import.meta.url).href);
  const manifest = packageManifest(pkg, lock, 'beta', ['@hono/node-server', 'zod']);
  assert.equal(manifest.dependencies['@hono/node-server'], '2.1.3');
  assert.equal(manifest.dependencies.zod, '4.6.6');
});
