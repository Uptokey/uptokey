// Keep the adapter intact. Its bundled Axios uses the Node HTTPS global agent
// when no explicit agent is configured. CONNECT preserves end-to-end TLS.
import https from 'node:https';
import { HttpsProxyAgent } from 'https-proxy-agent';

const proxy = process.env.HTTPS_PROXY;
if (proxy !== 'http://127.0.0.1:43190') throw new Error('Local API proxy unavailable');
https.globalAgent = new HttpsProxyAgent(proxy);
// Prevent Axios from wrapping an HTTPS request in an HTTP absolute-form request.
// Only this dedicated MCP subprocess changes its environment.
for (const name of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy']) delete process.env[name];
await import('@ivotoby/openapi-mcp-server/bin/mcp-server.js');
