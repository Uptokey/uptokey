export type OfferCostMode = "uptokey_included" | "user_account_free_or_trial" | "user_byok" | "local_compute";
export type OfferPrivacyClass =
  | "uptokey_hosted"
  | "external_training_possible"
  | "external_terms_apply"
  | "local_only";
export type OfferAvailability = "ready_when_configured" | "best_effort" | "requires_operator_activation";
export type OfferRouteKind = "hosted" | "provider" | "local" | "custom";

export interface OfferRoute {
  id: string;
  kind: OfferRouteKind;
  providerId: string;
  modelId: string | "auto";
  endpointFamily: "chat_completions" | "responses" | "system_one" | "local_runtime" | "hosted";
  requiresUserAccount: boolean;
  requiresUserKey: boolean;
  requiresOperatorCredit: boolean;
  supportLevel: "built_in" | "experimental" | "custom";
}

export interface UptokeyOffer {
  id: string;
  revision: number;
  titleKey: string;
  descriptionKey: string;
  intent:
    | "try_free"
    | "code_and_apps"
    | "fast_low_cost"
    | "private_local"
    | "included_by_uptokey"
    | "use_my_key"
    | "compare_models";
  costMode: OfferCostMode;
  privacyClass: OfferPrivacyClass;
  availability: OfferAvailability;
  routes: OfferRoute[];
}

function route(input: OfferRoute): OfferRoute {
  return Object.freeze({ ...input });
}

/**
 * Product offers, not a searchable provider directory and not landing-page routes.
 * A route listed here is a candidate behind an Uptokey promise; execution still
 * depends on provider config, consent, quota and the runtime adapter.
 */
export const UPTOKEY_OFFER_CATALOG: readonly UptokeyOffer[] = Object.freeze([
  {
    id: "uptokey-included",
    revision: 1,
    titleKey: "offer_uptokey_included_title",
    descriptionKey: "offer_uptokey_included_description",
    intent: "included_by_uptokey",
    costMode: "uptokey_included",
    privacyClass: "uptokey_hosted",
    availability: "requires_operator_activation",
    routes: [
      route({
        id: "hosted:cloudflare-workers-ai:auto",
        kind: "hosted",
        providerId: "cloudflare-workers-ai",
        modelId: "auto",
        endpointFamily: "hosted",
        requiresUserAccount: false,
        requiresUserKey: false,
        requiresOperatorCredit: true,
        supportLevel: "experimental",
      }),
    ],
  },
  {
    id: "free-to-try",
    revision: 1,
    titleKey: "offer_free_to_try_title",
    descriptionKey: "offer_free_to_try_description",
    intent: "try_free",
    costMode: "user_account_free_or_trial",
    privacyClass: "external_training_possible",
    availability: "best_effort",
    routes: [
      route({
        id: "zen:muse-spark-1.3-contributor-free",
        kind: "provider",
        providerId: "zen",
        modelId: "muse-spark-1.3-contributor-free",
        endpointFamily: "responses",
        requiresUserAccount: true,
        requiresUserKey: true,
        requiresOperatorCredit: false,
        supportLevel: "experimental",
      }),
      route({
        id: "zen:ling-3.0-flash-fin-free",
        kind: "provider",
        providerId: "zen",
        modelId: "ling-3.0-flash-fin-free",
        endpointFamily: "chat_completions",
        requiresUserAccount: true,
        requiresUserKey: true,
        requiresOperatorCredit: false,
        supportLevel: "experimental",
      }),
      route({
        id: "openrouter:openrouter/free",
        kind: "provider",
        providerId: "openrouter",
        modelId: "openrouter/free",
        endpointFamily: "chat_completions",
        requiresUserAccount: true,
        requiresUserKey: true,
        requiresOperatorCredit: false,
        supportLevel: "experimental",
      }),
    ],
  },
  {
    id: "code-and-apps",
    revision: 1,
    titleKey: "offer_code_and_apps_title",
    descriptionKey: "offer_code_and_apps_description",
    intent: "code_and_apps",
    costMode: "user_account_free_or_trial",
    privacyClass: "external_training_possible",
    availability: "best_effort",
    routes: [
      route({
        id: "zen:muse-spark-1.3-contributor-free",
        kind: "provider",
        providerId: "zen",
        modelId: "muse-spark-1.3-contributor-free",
        endpointFamily: "responses",
        requiresUserAccount: true,
        requiresUserKey: true,
        requiresOperatorCredit: false,
        supportLevel: "experimental",
      }),
      route({
        id: "github-models:auto",
        kind: "provider",
        providerId: "github-models",
        modelId: "auto",
        endpointFamily: "chat_completions",
        requiresUserAccount: true,
        requiresUserKey: true,
        requiresOperatorCredit: false,
        supportLevel: "experimental",
      }),
    ],
  },
  {
    id: "fast-low-cost",
    revision: 1,
    titleKey: "offer_fast_low_cost_title",
    descriptionKey: "offer_fast_low_cost_description",
    intent: "fast_low_cost",
    costMode: "user_account_free_or_trial",
    privacyClass: "external_terms_apply",
    availability: "best_effort",
    routes: [
      route({
        id: "groq:auto",
        kind: "provider",
        providerId: "groq",
        modelId: "auto",
        endpointFamily: "chat_completions",
        requiresUserAccount: true,
        requiresUserKey: true,
        requiresOperatorCredit: false,
        supportLevel: "built_in",
      }),
      route({
        id: "cerebras:auto",
        kind: "provider",
        providerId: "cerebras",
        modelId: "auto",
        endpointFamily: "chat_completions",
        requiresUserAccount: true,
        requiresUserKey: true,
        requiresOperatorCredit: false,
        supportLevel: "experimental",
      }),
    ],
  },
  {
    id: "private-local",
    revision: 1,
    titleKey: "offer_private_local_title",
    descriptionKey: "offer_private_local_description",
    intent: "private_local",
    costMode: "local_compute",
    privacyClass: "local_only",
    availability: "ready_when_configured",
    routes: [
      route({
        id: "ollama:auto",
        kind: "local",
        providerId: "ollama",
        modelId: "auto",
        endpointFamily: "local_runtime",
        requiresUserAccount: false,
        requiresUserKey: false,
        requiresOperatorCredit: false,
        supportLevel: "experimental",
      }),
      route({
        id: "vllm:auto",
        kind: "local",
        providerId: "vllm",
        modelId: "auto",
        endpointFamily: "local_runtime",
        requiresUserAccount: false,
        requiresUserKey: false,
        requiresOperatorCredit: false,
        supportLevel: "experimental",
      }),
    ],
  },
  {
    id: "use-my-key",
    revision: 1,
    titleKey: "offer_use_my_key_title",
    descriptionKey: "offer_use_my_key_description",
    intent: "use_my_key",
    costMode: "user_byok",
    privacyClass: "external_terms_apply",
    availability: "ready_when_configured",
    routes: [
      route({
        id: "custom:auto",
        kind: "custom",
        providerId: "custom",
        modelId: "auto",
        endpointFamily: "chat_completions",
        requiresUserAccount: true,
        requiresUserKey: true,
        requiresOperatorCredit: false,
        supportLevel: "custom",
      }),
    ],
  },
  {
    id: "compare-models",
    revision: 1,
    titleKey: "offer_compare_models_title",
    descriptionKey: "offer_compare_models_description",
    intent: "compare_models",
    costMode: "user_byok",
    privacyClass: "external_terms_apply",
    availability: "ready_when_configured",
    routes: [
      route({
        id: "openrouter:auto",
        kind: "provider",
        providerId: "openrouter",
        modelId: "auto",
        endpointFamily: "chat_completions",
        requiresUserAccount: true,
        requiresUserKey: true,
        requiresOperatorCredit: false,
        supportLevel: "experimental",
      }),
      route({
        id: "custom:auto",
        kind: "custom",
        providerId: "custom",
        modelId: "auto",
        endpointFamily: "chat_completions",
        requiresUserAccount: true,
        requiresUserKey: true,
        requiresOperatorCredit: false,
        supportLevel: "custom",
      }),
    ],
  },
]);

export function listUptokeyOffers(): readonly UptokeyOffer[] {
  return UPTOKEY_OFFER_CATALOG;
}

export function findUptokeyOffer(id: string): UptokeyOffer | null {
  return UPTOKEY_OFFER_CATALOG.find((offer) => offer.id === id) ?? null;
}

