/**
 * Connections — contrato canônico E2-02 (multicontas, testes e instalações locais).
 *
 * schemaVersion=1. Parsers rejeitam propriedades desconhecidas, protótipos
 * especiais e revisões obsoletas. Nenhum parser recebe ou devolve segredos:
 * perfis carregam `credentialRef` opaco; projeções públicas nunca o expõem.
 */

export const CONNECTIONS_SCHEMA_VERSION = 1;

export const CONNECTION_ACCESS_MODES = ["byok", "oauth", "custom", "local"];
export const CONNECTION_SUPPORT_LEVELS = ["built_in", "experimental", "custom", "research"];
export const CONNECTION_STATES = ["healthy", "degraded", "unauthenticated", "disabled", "unconfigured", "unknown", "expired"];
export const CONNECTION_TEST_MODES = ["metadata", "inference"];
export const CONNECTION_TEST_STATES = ["queued", "running", "succeeded", "partial", "failed", "cancelled", "interrupted"];
export const CONNECTION_TEST_RESULTS = ["ok", "unauthorized", "rate_limited", "timeout", "unreachable", "skipped", "failed"];
export const MODEL_INSTALL_RUNTIMES = ["ollama", "vllm"];
export const MODEL_INSTALL_STATES = ["queued", "downloading", "verifying", "ready", "failed", "cancelled", "interrupted"];

export const CONNECTION_LIMITS = {
  maxConnectionsPerDevice: 64,
  maxTestConnections: 64,
  maxTestCalls: 64,
  maxConcurrentTests: 4,
  testTimeoutMs: 30_000,
  maxConcurrentInstalls: 2,
  maxLabelLength: 80,
  maxModelIds: 256,
};

export const CONNECTION_ERROR_TYPES = [
  "connection_not_found",
  "revision_conflict",
  "credential_missing",
  "provider_terms_unverified",
  "oauth_state_invalid",
  "oauth_scope_denied",
  "oauth_attempt_expired",
  "test_budget_exceeded",
  "runtime_unavailable",
  "disk_space_insufficient",
  "endpoint_denied",
  "connection_limit_exceeded",
  "operation_replayed",
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROVIDER_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SECRET_PROTO_RE = /__proto__|constructor|prototype/;
const MICRO_AMOUNT_RE = /^\d{1,18}$/;

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || SECRET_PROTO_RE.test(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return false;
  }
  return true;
}

function rejectUnknown(value, allowed, code) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(code);
  }
}

function parseRevision(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("connection_invalid_revision");
  return value;
}

function parseLabel(value) {
  if (typeof value !== "string") throw new Error("connection_invalid_label");
  const label = value.trim();
  if (label.length < 1 || label.length > CONNECTION_LIMITS.maxLabelLength) throw new Error("connection_invalid_label");
  return label;
}

function parseProviderId(value) {
  if (typeof value !== "string" || !PROVIDER_RE.test(value)) throw new Error("connection_invalid_provider");
  return value;
}

function parseModelIds(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > CONNECTION_LIMITS.maxModelIds) throw new Error("connection_invalid_models");
  for (const id of value) {
    if (typeof id !== "string" || id.length < 1 || id.length > 200) throw new Error("connection_invalid_models");
  }
  return [...value];
}

function parseEndpointUrl(value, accessMode) {
  if (value === undefined || value === null) {
    if (accessMode === "custom") throw new Error("endpoint_denied");
    return null;
  }
  if (typeof value !== "string" || value.length > 2048) throw new Error("endpoint_denied");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("endpoint_denied");
  }
  if (url.username || url.password || url.hash) throw new Error("endpoint_denied");
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  if (url.protocol === "https:") return url.toString();
  if (url.protocol === "http:" && loopback && (accessMode === "local" || accessMode === "custom")) return url.toString();
  throw new Error("endpoint_denied");
}

/**
 * Perfil de conexão multiconta. `id` ausente significa criação (o serviço gera).
 * `credentialRef` é referência opaca ao SecretStore — nunca o segredo.
 */
export function parseConnectionProfile(input) {
  if (!isPlainRecord(input)) throw new Error("connection_invalid_profile");
  rejectUnknown(input, [
    "schemaVersion", "id", "revision", "providerId", "label", "accessMode",
    "enabled", "endpointUrl", "modelIds", "credentialRef", "proxyPoolId", "priority", "commercialAccountId", "imageInputModels",
    "audioInputModels", "toolModels", "jsonSchemaModels",
  ], "connection_unknown_property");
  if (input.schemaVersion !== CONNECTIONS_SCHEMA_VERSION) throw new Error("connection_stale_revision");
  const accessMode = input.accessMode;
  if (!CONNECTION_ACCESS_MODES.includes(accessMode)) throw new Error("connection_invalid_access_mode");
  const profile = {
    schemaVersion: CONNECTIONS_SCHEMA_VERSION,
    revision: parseRevision(input.revision ?? 1),
    providerId: parseProviderId(input.providerId),
    label: parseLabel(input.label),
    accessMode,
    enabled: input.enabled ?? true,
    endpointUrl: parseEndpointUrl(input.endpointUrl, accessMode),
    modelIds: parseModelIds(input.modelIds),
  };
  if (typeof profile.enabled !== "boolean") throw new Error("connection_invalid_profile");
  if (input.commercialAccountId !== undefined) {
    if (accessMode !== 'byok' && accessMode !== 'custom') throw new Error('connection_invalid_commercial_account');
    profile.commercialAccountId = parseCommercialAccountId(input.commercialAccountId);
  }
  for (const [kind, field] of Object.entries(DECLARED_CAPABILITY_FIELDS)) {
    if (input[field] === undefined) continue;
    const declared = parseDeclaredCapabilityModels(kind, input[field]);
    if (declared.length) profile[field] = declared;
  }
  if (input.id !== undefined) {
    if (typeof input.id !== "string" || !UUID_RE.test(input.id)) throw new Error("connection_invalid_profile");
    profile.id = input.id;
  }
  if (input.credentialRef !== undefined) {
    if (typeof input.credentialRef !== "string" || input.credentialRef.length > 160 || SECRET_PROTO_RE.test(input.credentialRef)) {
      throw new Error("connection_invalid_profile");
    }
    profile.credentialRef = input.credentialRef;
  }
  if (input.proxyPoolId !== undefined) {
    if (typeof input.proxyPoolId !== "string" || !UUID_RE.test(input.proxyPoolId)) throw new Error("connection_invalid_profile");
    profile.proxyPoolId = input.proxyPoolId;
  }
  if (input.priority !== undefined) {
    if (!Number.isSafeInteger(input.priority) || input.priority < 0 || input.priority > 1_000_000) {
      throw new Error("connection_invalid_profile");
    }
    profile.priority = input.priority;
  } else {
    profile.priority = 0;
  }
  return profile;
}

/** Atualização parcial: exige `revision` esperada (CAS) e ao menos um campo. */
export function parseCommercialAccountId(value) {
  if (typeof value !== 'string') throw new Error('connection_invalid_commercial_account');
  const id = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) || SECRET_PROTO_RE.test(id)) throw new Error('connection_invalid_commercial_account');
  return id;
}

/**
 * Capabilities a request may require from its destination. Inputs (image, audio) are separate
 * from request features (tools, json_schema) and from generation executors (image/speech/video
 * services), which have their own connections. Each is a per-model declaration on the connection,
 * never inferred from a model name or from OpenAI compatibility; the router enforces it at dispatch.
 */
export const REQUIRED_CAPABILITIES = Object.freeze(["image", "audio", "tools", "json_schema"]);
export const DECLARED_CAPABILITY_FIELDS = Object.freeze({
  image: "imageInputModels", audio: "audioInputModels", tools: "toolModels", json_schema: "jsonSchemaModels",
});
const CAPABILITY_ERROR = { image: "connection_invalid_image_input", audio: "connection_invalid_audio_input", tools: "connection_invalid_tool_models", json_schema: "connection_invalid_json_schema_models" };

export function parseDeclaredCapabilityModels(kind, value) {
  const code = CAPABILITY_ERROR[kind];
  if (!code) throw new Error("connection_invalid_profile");
  if (!Array.isArray(value) || value.length > 200) throw new Error(code);
  const seen = new Set();
  for (const id of value) {
    if (typeof id !== "string" || id.length < 1 || id.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(id) || seen.has(id)) throw new Error(code);
    seen.add(id);
  }
  return [...seen];
}

/** Models the user declares as accepting image input on this connection. */
export function parseImageInputModels(value) {
  return parseDeclaredCapabilityModels("image", value);
}

/** A request's required capabilities: 1–4 distinct known kinds, in canonical order. */
export function parseRequiredCapabilities(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > REQUIRED_CAPABILITIES.length) throw new Error("required_capability_invalid");
  const seen = new Set(value);
  if (seen.size !== value.length || value.some(kind => !REQUIRED_CAPABILITIES.includes(kind))) throw new Error("required_capability_invalid");
  return REQUIRED_CAPABILITIES.filter(kind => seen.has(kind));
}

export function parseConnectionPatch(input) {
  if (!isPlainRecord(input)) throw new Error("connection_invalid_profile");
  rejectUnknown(input, ["revision", "label", "enabled", "endpointUrl", "modelIds", "priority", "proxyPoolId", "commercialAccountId", "imageInputModels",
    "audioInputModels", "toolModels", "jsonSchemaModels"], "connection_unknown_property");
  const keys = Object.keys(input).filter((k) => k !== "revision");
  if (keys.length < 1) throw new Error("connection_invalid_profile");
  const patch = { revision: parseRevision(input.revision) };
  if (input.commercialAccountId !== undefined) patch.commercialAccountId = input.commercialAccountId === null ? null : parseCommercialAccountId(input.commercialAccountId);
  for (const [kind, field] of Object.entries(DECLARED_CAPABILITY_FIELDS)) {
    if (input[field] !== undefined) patch[field] = input[field] === null ? null : parseDeclaredCapabilityModels(kind, input[field]);
  }
  if (input.label !== undefined) patch.label = parseLabel(input.label);
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") throw new Error("connection_invalid_profile");
    patch.enabled = input.enabled;
  }
  if (input.endpointUrl !== undefined) patch.endpointUrl = parseEndpointUrl(input.endpointUrl, "custom");
  if (input.modelIds !== undefined) patch.modelIds = parseModelIds(input.modelIds);
  if (input.priority !== undefined) {
    if (!Number.isSafeInteger(input.priority) || input.priority < 0 || input.priority > 1_000_000) {
      throw new Error("connection_invalid_profile");
    }
    patch.priority = input.priority;
  }
  if (input.proxyPoolId !== undefined) {
    if (input.proxyPoolId !== null && (typeof input.proxyPoolId !== "string" || !UUID_RE.test(input.proxyPoolId))) {
      throw new Error("connection_invalid_profile");
    }
    patch.proxyPoolId = input.proxyPoolId;
  }
  return patch;
}

/**
 * Projeção pública: nunca contém credentialRef, tokens ou chaves.
 * `accountLabel` já vem mascarado do serviço; aqui só se garante o formato.
 */
export function projectConnectionView(profile, derived) {
  const parsed = parseConnectionProfile(profile);
  if (!isPlainRecord(derived)) throw new Error("connection_invalid_profile");
  rejectUnknown(derived, ["credentialPresent", "accountLabel", "supportLevel", "status", "observedAt"], "connection_unknown_property");
  if (typeof derived.credentialPresent !== "boolean") throw new Error("connection_invalid_profile");
  if (typeof derived.accountLabel !== "string" || derived.accountLabel.length > 120) throw new Error("connection_invalid_profile");
  if (!CONNECTION_SUPPORT_LEVELS.includes(derived.supportLevel)) throw new Error("connection_invalid_profile");
  if (!CONNECTION_STATES.includes(derived.status)) throw new Error("connection_invalid_profile");
  if (typeof derived.observedAt !== "string" || Number.isNaN(Date.parse(derived.observedAt))) {
    throw new Error("connection_invalid_profile");
  }
  const { credentialRef: _dropped, ...publicProfile } = parsed;
  return {
    ...publicProfile,
    credentialPresent: derived.credentialPresent,
    accountLabel: derived.accountLabel,
    supportLevel: derived.supportLevel,
    status: derived.status,
    observedAt: derived.observedAt,
  };
}

/** Especificação de um teste em lote: 1–64 conexões únicas, teto de chamadas e custo. */
export function parseConnectionTestSpec(input) {
  if (!isPlainRecord(input)) throw new Error("connection_invalid_test");
  rejectUnknown(input, ["connectionIds", "mode", "maxCalls", "maxCostMicros", "operationId"], "connection_unknown_property");
  if (!Array.isArray(input.connectionIds) || input.connectionIds.length < 1 || input.connectionIds.length > CONNECTION_LIMITS.maxTestConnections) {
    throw new Error("connection_invalid_test");
  }
  const seen = new Set();
  for (const id of input.connectionIds) {
    if (typeof id !== "string" || !UUID_RE.test(id) || seen.has(id)) throw new Error("connection_invalid_test");
    seen.add(id);
  }
  if (!CONNECTION_TEST_MODES.includes(input.mode)) throw new Error("connection_invalid_test");
  const maxCalls = input.maxCalls ?? input.connectionIds.length;
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > CONNECTION_LIMITS.maxTestCalls) {
    throw new Error("connection_invalid_test");
  }
  const maxCostMicros = input.maxCostMicros ?? "0";
  if (typeof maxCostMicros !== "string" || !MICRO_AMOUNT_RE.test(maxCostMicros)) throw new Error("connection_invalid_test");
  if (input.mode === "inference" && maxCostMicros === "0") throw new Error("test_budget_exceeded");
  if (input.operationId !== undefined && (typeof input.operationId !== "string" || !UUID_RE.test(input.operationId))) {
    throw new Error("connection_invalid_test");
  }
  return { connectionIds: [...seen], mode: input.mode, maxCalls, maxCostMicros, operationId: input.operationId };
}

/** Resultado individual de um teste: sem corpo de resposta, só o veredito. */
export function parseConnectionTestResult(input) {
  if (!isPlainRecord(input)) throw new Error("connection_invalid_test");
  rejectUnknown(input, ["connectionId", "result", "latencyMs", "observedAt", "note"], "connection_unknown_property");
  if (typeof input.connectionId !== "string" || !UUID_RE.test(input.connectionId)) throw new Error("connection_invalid_test");
  if (!CONNECTION_TEST_RESULTS.includes(input.result)) throw new Error("connection_invalid_test");
  if (input.latencyMs !== undefined && (!Number.isSafeInteger(input.latencyMs) || input.latencyMs < 0)) {
    throw new Error("connection_invalid_test");
  }
  if (typeof input.observedAt !== "string" || Number.isNaN(Date.parse(input.observedAt))) throw new Error("connection_invalid_test");
  if (input.note !== undefined && (typeof input.note !== "string" || input.note.length > 200)) throw new Error("connection_invalid_test");
  return {
    connectionId: input.connectionId,
    result: input.result,
    ...(input.latencyMs !== undefined ? { latencyMs: input.latencyMs } : {}),
    observedAt: input.observedAt,
    ...(input.note !== undefined ? { note: input.note } : {}),
  };
}

/** Especificação de instalação de modelo local: runtime, modelo, destino e integridade. */
export function parseModelInstallSpec(input) {
  if (!isPlainRecord(input)) throw new Error("connection_invalid_install");
  rejectUnknown(input, ["runtime", "modelId", "destinationId", "expectedDigest", "operationId"], "connection_unknown_property");
  if (!MODEL_INSTALL_RUNTIMES.includes(input.runtime)) throw new Error("connection_invalid_install");
  if (typeof input.modelId !== "string" || input.modelId.length < 1 || input.modelId.length > 200) {
    throw new Error("connection_invalid_install");
  }
  if (typeof input.destinationId !== "string" || input.destinationId.length < 1 || input.destinationId.length > 120) {
    throw new Error("connection_invalid_install");
  }
  if (input.expectedDigest !== undefined && input.expectedDigest !== null) {
    if (typeof input.expectedDigest !== "string" || input.expectedDigest.length > 256) throw new Error("connection_invalid_install");
  }
  if (input.operationId !== undefined && (typeof input.operationId !== "string" || !UUID_RE.test(input.operationId))) {
    throw new Error("connection_invalid_install");
  }
  return {
    runtime: input.runtime,
    modelId: input.modelId,
    destinationId: input.destinationId,
    expectedDigest: input.expectedDigest ?? null,
    operationId: input.operationId,
  };
}

/** Início OAuth: provedor oficial, escopos permitidos e retorno loopback. */
export function parseOAuthStart(input) {
  if (!isPlainRecord(input)) throw new Error("connection_invalid_oauth");
  rejectUnknown(input, ["providerId", "scopes", "operationId"], "connection_unknown_property");
  const providerId = parseProviderId(input.providerId);
  if (!Array.isArray(input.scopes) || input.scopes.length < 1 || input.scopes.length > 32) throw new Error("oauth_scope_denied");
  for (const scope of input.scopes) {
    if (typeof scope !== "string" || scope.length < 1 || scope.length > 120) throw new Error("oauth_scope_denied");
  }
  if (input.operationId !== undefined && (typeof input.operationId !== "string" || !UUID_RE.test(input.operationId))) {
    throw new Error("connection_invalid_oauth");
  }
  return { providerId, scopes: [...input.scopes], operationId: input.operationId };
}

/**
 * Canário E2-02 (AC-02-08/C09): projeções públicas, logs e exports nunca
 * carregam chaves de segredo. Falha fechada antes de persistir ou exibir.
 */
export function assertViewHasNoSecrets(payload) {
  let text;
  try {
    text = JSON.stringify(payload);
  } catch {
    throw new Error("connection_secret_leaked");
  }
  if (typeof text !== "string") throw new Error("connection_secret_leaked");
  if (/"credentialRef"\s*:/.test(text)) throw new Error("connection_secret_leaked");
  if (/"refreshToken"\s*:/.test(text) || /refresh_token/.test(text)) throw new Error("connection_secret_leaked");
  if (/"accessToken"\s*:/.test(text) || /"access_token"\s*:/.test(text)) throw new Error("connection_secret_leaked");
  if (/"apiKey"\s*:/.test(text) || /"api_key"\s*:/.test(text)) throw new Error("connection_secret_leaked");
}
