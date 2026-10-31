import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

// Keep browser operations in the official Playwright implementation. In particular,
// its RCE-equivalent run_code tool must not become an escape from the file boundary.
export const BROWSER_TOOLS = new Set([
  'browser_close', 'browser_resize', 'browser_console_messages',
  'browser_handle_dialog', 'browser_evaluate', 'browser_find', 'browser_fill_form',
  'browser_click', 'browser_drag', 'browser_hover', 'browser_select_option',
  'browser_press_key', 'browser_type', 'browser_navigate', 'browser_navigate_back',
  'browser_navigate_forward', 'browser_reload', 'browser_network_requests',
  'browser_take_screenshot', 'browser_tabs', 'browser_wait_for', 'browser_snapshot',
  'browser_mouse_move_xy', 'browser_mouse_click_xy', 'browser_mouse_drag_xy',
  'browser_mouse_wheel', 'browser_verify_element_visible', 'browser_verify_text_visible',
  'browser_verify_list_visible', 'browser_verify_value', 'browser_generate_locator',
]);

export function publicBrowserUrl(value, allowedOrigin) {
  if (value === 'about:blank') return;
  let url;
  try { url = new URL(value); } catch { return 'Use a complete HTTP or HTTPS URL.'; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    return 'Only HTTP(S) browsing without credentials in the URL is supported.';
  if (allowedOrigin && url.origin === allowedOrigin) return;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
      || isIP(host) === 6 && !/^[23][0-9a-f]{0,3}:/.test(host)
      || isIP(host) === 4 && (
        /^(0|10|127)\./.test(host) || /^192\.168\./.test(host)
        || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
        || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)
        || /^198\.1[89]\./.test(host) || Number(host.split('.')[0]) >= 224))
    return 'Private network and local service targets require a separately configured browser scope.';
}

export async function browserNetworkDenial(value, allowedOrigin, resolveHost = lookup) {
  const direct = publicBrowserUrl(value, allowedOrigin);
  if (direct || value === 'about:blank') return direct;
  const url = new URL(value);
  if (allowedOrigin && url.origin === allowedOrigin) return;
  try {
    const addresses = await resolveHost(url.hostname.replace(/^\[|\]$/g, ''), { all: true, verbatim: true });
    if (!addresses.length || addresses.some(({ address }) => publicBrowserUrl(`http://${isIP(address) === 6 ? `[${address}]` : address}/`)))
      return 'Browser target resolves to a private or unavailable network address.';
  } catch { return 'Browser target cannot be resolved.'; }
}

export function browserCallDenial(name, args = {}, { allowedOrigin } = {}) {
  if (!BROWSER_TOOLS.has(name)) return 'This browser capability is outside the isolated browser scope.';
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'Browser arguments must be an object.';
  if (Object.hasOwn(args, '_meta')) return 'Browser callers cannot override transport metadata or artifact roots.';
  if (args.filename !== undefined && (typeof args.filename !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(args.filename)
      || args.filename.includes('..')))
    return 'Browser artifacts must use a plain filename inside the temporary artifact directory.';
  if (name === 'browser_navigate' || name === 'browser_tabs' && args.url)
    return publicBrowserUrl(args.url, allowedOrigin);
  if (name === 'browser_resize' && (!Number.isInteger(args.width) || !Number.isInteger(args.height)
      || args.width < 240 || args.height < 200 || args.width > 3840 || args.height > 2160))
    return 'Browser viewport must be between 240x200 and 3840x2160.';
  if (name === 'browser_wait_for' && args.time !== undefined && (args.time < 0 || args.time > 30))
    return 'A browser wait is limited to 30 seconds.';
}

/** Public SDK transport adapter: no browser protocol, tool implementation or auth fork. */
export function scopedBrowserTransport(inner, rootUri, options = {}) {
  const listIds = new Set();
  const rootIds = new Set();
  const queued = [];
  let active;
  const pump = () => {
    if (active || !queued.length) return;
    active = queued.shift();
    options.onActivity?.();
    transport.onmessage?.(active);
  };
  const transport = {
    async start() {
      inner.onmessage = message => {
        if (rootIds.delete(message.id)) {
          message = { jsonrpc: '2.0', id: message.id, result: { roots: [{ uri: rootUri, name: 'temporary-browser-artifacts' }] } };
        }
        if (message.method === 'tools/list') listIds.add(message.id);
        if (message.method === 'tools/call') {
          const denial = browserCallDenial(message.params?.name, message.params?.arguments, options);
          if (denial) {
            void inner.send({ jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: denial }] } });
            return;
          }
          if (queued.length >= 32) {
            void inner.send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Browser action queue is full.' } });
            return;
          }
          queued.push(message);
          pump();
          return;
        }
        if (message.method === 'notifications/cancelled') {
          const requestId = message.params?.requestId;
          const index = queued.findIndex(request => request.id === requestId);
          if (index >= 0) queued.splice(index, 1);
          if (active?.id === requestId) void Promise.resolve(options.onCancel?.()).catch(error => transport.onerror?.(error));
        }
        transport.onmessage?.(message);
      };
      inner.onerror = error => transport.onerror?.(error);
      inner.onclose = () => transport.onclose?.();
      await inner.start();
    },
    async send(message) {
      if (listIds.delete(message.id) && message.result?.tools)
        message = { ...message, result: { ...message.result, tools: message.result.tools.filter(tool => BROWSER_TOOLS.has(tool.name)) } };
      if (message.method === 'roots/list') rootIds.add(message.id);
      const completed = active?.id === message.id && (message.result !== undefined || message.error !== undefined);
      if (completed && active.params?.name === 'browser_close' && !message.result?.isError) await options.onBrowserClose?.();
      await inner.send(message);
      if (completed) { active = undefined; pump(); }
    },
    close() { listIds.clear(); rootIds.clear(); queued.length = 0; active = undefined; return inner.close(); },
  };
  return transport;
}
