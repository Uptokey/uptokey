export function canonicalHttpsOrigin(value) {
  if (typeof value !== "string" || value.length > 255) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" && url.pathname === "/" && url.search === "" && url.hash === "" && url.origin === value;
  } catch { return false; }
}

export function canonicalMagicDnsName(value) {
  return typeof value === "string" && value.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net$/.test(value);
}
