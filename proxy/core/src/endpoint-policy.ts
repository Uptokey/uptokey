// SPEC-011: politica de endpoint por classe de provider.
// Ollama (nivel 2) roda sem TLS — so pode apontar para localhost.
// Named experimental e custom remoto exigem HTTPS fora de localhost.
// User-defined providers (custom-*) seguem a mesma política de custom.
// Mensagem de erro nunca inclui a URL: ela pode conter credencial embutida.

import { isLocalExperimentalProvider, isNamedExperimentalProvider, isUserDefinedProvider, NAMED_EXPERIMENTAL_DEFAULTS, type OptionalProviderName } from "./provider-registry.ts";

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

// SPEC-061: userinfo (`https://user:pass@host`) não é o único lugar onde uma chave cabe numa URL.
// `?api_key=`, `?key=` e `#token=` também carregam credencial, e o endpoint é persistido em texto
// claro no config.json e renderizado no mini-UI (/ui) — ou seja, sai do cofre do SO. Só nomes de
// parâmetro credenciais são recusados: parâmetros operacionais legítimos (`api-version` do Azure
// OpenAI, por exemplo) continuam aceitos, porque bloquear toda query removeria conexões válidas.
const CREDENTIAL_PARAM_NAME = /^(?:x[_-]?)?(?:api[_-]?key|apikey|key|access[_-]?key|access[_-]?token|auth|authorization|token|secret|client[_-]?secret|password|passwd|pwd|credential|sig|signature|subscription[_-]?key)$/i;

export type EndpointPolicyName = OptionalProviderName | string;

/**
 * Recusa endpoints que embutem credencial na própria URL (userinfo, query ou fragmento).
 * Aplicado nos caminhos de *escrita* de configuração — a validação de config já persistida
 * permanece tolerante para não impedir a inicialização de um beta já instalado.
 */
export function assertEndpointCredentialFree(rawUrl: string): void {
  let parsed: URL;
  try { parsed = new URL(rawUrl); }
  catch { throw new Error("endpoint_url_invalid"); }
  if (parsed.username !== "" || parsed.password !== "") throw new Error("endpoint_credentials_forbidden");
  // O fragmento nunca chega ao servidor: num endpoint de API ele só serve para esconder valor.
  if (parsed.hash !== "") throw new Error("endpoint_credentials_forbidden");
  for (const name of parsed.searchParams.keys()) {
    if (CREDENTIAL_PARAM_NAME.test(name)) throw new Error("endpoint_credentials_forbidden");
  }
}

/**
 * Projeção segura do endpoint para exibição (mini-UI, mensagens, diagnóstico).
 * Mantém a URL reconhecível e substitui apenas o valor de parâmetros credenciais, cobrindo
 * também configurações gravadas antes de `assertEndpointCredentialFree` existir.
 */
export function redactEndpointCredentials(rawUrl: string): string {
  let parsed: URL;
  try { parsed = new URL(rawUrl); }
  catch { return rawUrl; }
  let changed = false;
  if (parsed.username !== "" || parsed.password !== "") { parsed.username = ""; parsed.password = ""; changed = true; }
  if (parsed.hash !== "") { parsed.hash = ""; changed = true; }
  for (const name of [...parsed.searchParams.keys()]) {
    if (!CREDENTIAL_PARAM_NAME.test(name)) continue;
    parsed.searchParams.set(name, "[redacted]");
    changed = true;
  }
  return changed ? parsed.href : rawUrl;
}

export function isLocalHostname(hostname: string): boolean {
  return LOCAL_HOSTNAMES.has(hostname) || LOCAL_HOSTNAMES.has(hostname.replace(/^\[|\]$/g, ""));
}

export function isLocalEndpointUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && parsed.username === ""
      && parsed.password === ""
      && isLocalHostname(parsed.hostname);
  } catch {
    return false;
  }
}

export function assertProviderEndpointUrl(name: EndpointPolicyName, rawUrl: string): void {
  if (rawUrl.length < 1 || rawUrl.length > 2_048) throw new Error("endpoint_url_invalid");
  let parsed: URL;
  try { parsed = new URL(rawUrl); }
  catch { throw new Error("endpoint_url_invalid"); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("endpoint_protocol_forbidden");
  if (parsed.username !== "" || parsed.password !== "") throw new Error("endpoint_credentials_forbidden");
  const local = isLocalHostname(parsed.hostname);
  if (isLocalExperimentalProvider(name) && !local) throw new Error(name === "ollama" ? "endpoint_ollama_remote_forbidden" : "endpoint_vllm_remote_forbidden");
  if (isNamedExperimentalProvider(name)) {
    const expected = new URL(NAMED_EXPERIMENTAL_DEFAULTS[name].endpointUrl);
    if (parsed.href !== expected.href) throw new Error("endpoint_named_profile_mismatch");
  }
  if ((name === "custom" || isUserDefinedProvider(name) || isNamedExperimentalProvider(name)) && !local && parsed.protocol !== "https:") {
    throw new Error("endpoint_https_required");
  }
}
