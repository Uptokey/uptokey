import { browserNetworkDenial } from './playwright-policy.mjs';

const installed = new WeakSet();
let allowedOrigin;
export function configureBrowserOrigin(origin) { allowedOrigin = origin; }
export default async function initializePage({ page }) {
  const context = page.context();
  if (installed.has(context)) return;
  installed.add(context);
  await context.route('**/*', async route => {
    if (await browserNetworkDenial(route.request().url(), allowedOrigin)) await route.abort('blockedbyclient');
    else await route.continue();
  });
  // A public page must not create a websocket to a native service either.
  await context.routeWebSocket('**/*', socket => socket.close({ code: 1008, reason: 'Websocket access is outside this browser scope.' }));
}
