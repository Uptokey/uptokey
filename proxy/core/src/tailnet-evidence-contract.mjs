export const TAILNET_EVIDENCE_SCHEMA_VERSION = 6;
export const TAILNET_EVIDENCE_CHECK_NAMES = Object.freeze([
  "localhost_health",
  "localhost_rejects_browser_origin",
  "tailnet_preflight_pna",
  "tailnet_preflight_rejects_unpublished_surface",
  "tailnet_real_requests_enforce_method_and_media",
  "tailnet_has_no_inference",
  "tailnet_rejects_evil_origin_without_acao",
  "tailnet_rejects_null_origin",
  "tailnet_rejects_query_scope",
  "tailnet_rejects_local_inference_token",
  "tailnet_rejects_plaintext_bootstrap"
]);
