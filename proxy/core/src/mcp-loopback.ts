/**
 * Hard loopback binding for MCP → proxy traffic.
 * Only http://127.0.0.1:21435 is accepted (no localhost DNS, no IPv6, no HTTPS, no redirects).
 */
export const MCP_PROXY_ORIGIN = "http://127.0.0.1:21435";
export const MCP_PROXY_HOST = "127.0.0.1:21435";

export function assertLoopbackProxyUrl(input: string | URL): URL {
  let url: URL;
  try {
    url = input instanceof URL ? new URL(input.href) : new URL(input);
  } catch {
    throw new Error("mcp_proxy_url_invalid");
  }
  if (url.protocol !== "http:") throw new Error("mcp_proxy_protocol_forbidden");
  if (url.hostname !== "127.0.0.1") throw new Error("mcp_proxy_host_forbidden");
  if (url.port !== "21435") throw new Error("mcp_proxy_port_forbidden");
  if (url.username || url.password) throw new Error("mcp_proxy_userinfo_forbidden");
  return url;
}

export function loopbackProxyUrl(path: string): URL {
  if (!path.startsWith("/")) throw new Error("mcp_proxy_path_invalid");
  if (path.includes("://") || path.includes("\\")) throw new Error("mcp_proxy_path_invalid");
  return assertLoopbackProxyUrl(new URL(path, MCP_PROXY_ORIGIN));
}
