import { mkdtemp, mkdir, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createConnection } from '@playwright/mcp';
import { chromium } from 'playwright';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { scopedBrowserTransport } from './playwright-policy.mjs';
import { configureBrowserOrigin } from './playwright-network.mjs';

export function browserConfig(scratch, { proxy } = {}) {
  return {
    browser: {
      browserName: 'chromium', isolated: true,
      initPage: [fileURLToPath(new URL('./playwright-network.mjs', import.meta.url))],
      launchOptions: { headless: true, chromiumSandbox: true, ...(proxy ? { proxy: { server: proxy, bypass: '<-loopback>' } } : {}) },
      contextOptions: { acceptDownloads: false, serviceWorkers: 'block', viewport: { width: 1280, height: 800 } },
    },
    capabilities: ['vision', 'testing'],
    webmcp: false, saveSession: false, sharedBrowserContext: false,
    outputDir: scratch, outputMaxSize: 32 * 1024 * 1024,
    allowUnrestrictedFileAccess: false, imageResponses: 'allow', codegen: 'none',
    timeouts: { action: 10000, navigation: 30000, expect: 10000, idle: 300000 },
  };
}

export async function startBrowserServer({ allowedOrigin, proxy = 'http://127.0.0.1:43190', temporaryRoot = tmpdir() } = {}) {
  const scratch = await mkdtemp(join(resolve(temporaryRoot), 'uptokey-browser-'));
  await chmod(scratch, 0o700);
  await mkdir(join(scratch, 'home'), { mode: 0o700 });
  const originalCwd = process.cwd();
  process.chdir(scratch);
  // Profiles, traces, logs and arbitrary inherited tokens never reach the browser.
  for (const key of Object.keys(process.env)) {
    if (!/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|LANG|LC_ALL|PLAYWRIGHT_BROWSERS_PATH)$/i.test(key)) delete process.env[key];
  }
  process.env.HOME = join(scratch, 'home');
  process.env.USERPROFILE = join(scratch, 'home');
  process.env.TMPDIR = scratch;
  process.env.TEMP = scratch;
  process.env.TMP = scratch;
  configureBrowserOrigin(allowedOrigin);
  const config = browserConfig(scratch, { proxy });
  let browserPromise, contextPromise, idleTimer, closing;
  const closeBrowser = async () => {
    const previous = browserPromise;
    browserPromise = undefined;
    contextPromise = undefined;
    const browser = await previous?.catch(() => undefined);
    await browser?.close();
  };
  const getContext = () => contextPromise ??= (async () => {
    if (closing) throw Error('Browser session is closing.');
    browserPromise ??= chromium.launch({ ...config.browser.launchOptions, handleSIGINT: false, handleSIGTERM: false });
    const browser = await browserPromise;
    if (closing) { await browser.close(); throw Error('Browser session was cancelled.'); }
    return browser.newContext(config.browser.contextOptions);
  })();
  // The official contextGetter API expects isolated=false because it receives an
  // already-created context. The owner above always creates a fresh incognito
  // context with Chromium.newContext(), never a persistent or personal profile.
  const server = await createConnection({ ...config, browser: { ...config.browser, isolated: false } }, getContext);
  const exit = () => void close().finally(() => process.exit(0));
  const touch = () => { clearTimeout(idleTimer); idleTimer = setTimeout(exit, 300000); idleTimer.unref(); };
  const transport = scopedBrowserTransport(new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 1024 * 1024 }), pathToFileURL(scratch).href, {
    allowedOrigin, onCancel: exit, onBrowserClose: closeBrowser, onActivity: touch,
  });
  const close = () => closing ??= (async () => {
    clearTimeout(idleTimer);
    await closeBrowser();
    await server.close();
    process.chdir(originalCwd);
    await rm(scratch, { recursive: true, force: true });
  })();
  process.once('SIGTERM', exit);
  process.once('SIGINT', exit);
  process.stdin.once('end', exit);
  await server.connect(transport);
  touch();
  return { close, scratch };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // This optional origin is deployment-owned; it cannot be altered by an MCP call.
  const allowedOrigin = process.env.UPTOKEY_BROWSER_ALLOWED_ORIGIN;
  if (allowedOrigin && new URL(allowedOrigin).origin !== allowedOrigin) throw Error('Invalid browser origin scope');
  const proxy = process.env.UPTOKEY_BROWSER_PROXY;
  if (proxy && !/^http:\/\/127\.0\.0\.1:43190$/.test(proxy)) throw Error('Invalid browser proxy');
  await startBrowserServer({ allowedOrigin, proxy });
}
