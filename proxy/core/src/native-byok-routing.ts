import type { ResolvedClient } from './client-keys.ts';
import type { ConnectionProfileService } from './connection-profiles.ts';
import { isProvider } from './provider-registry.ts';
import type { ChatCompletionRequest, ProxyConfig } from './types.ts';

/** Harness sends a plain model ID. Bind an unambiguous BYOK model to its saved
 * account, preserving virtual routes, explicit caller policy and local models. */
export async function nativeByokDestination(
  request: ChatCompletionRequest,
  client: ResolvedClient,
  config: ProxyConfig,
  profiles: Pick<ConnectionProfileService, 'list'> | undefined,
) {
  const model = request.model;
  if (!profiles || client.registration?.audience !== 'tauri' || client.registration.enrolledVia !== 'pairing' ||
      client.registration.projects !== '*' ||
      client.delegation || !client.policy || client.policy.retentionMode === 'ephemeral' ||
      client.policy.providerIds.length || request.uptokey_provider !== undefined || request.uptokey_account !== undefined ||
      request.uptokey_require_model === false ||
      request.uptokey_routing_combo !== undefined || config.activeRoutingComboId ||
      !model || model.startsWith('@') || ['auto', 'uptokey-auto', 'uptokey-coder', 'uptokey-fast'].includes(model)) return undefined;
  // Avoid touching the profile store for virtual/unknown IDs or an installed local model.
  const candidates = Object.keys(config.providers).filter(isProvider).filter(id => {
    const provider = config.providers[id];
    return provider?.enabled && provider.configured && provider.models.includes(model);
  });
  if (!candidates.length || candidates.some(id => id === 'ollama' || id === 'vllm')) return undefined;
  const profilesForModel = (await profiles.list()).filter(profile =>
    isProvider(profile.providerId) && candidates.includes(profile.providerId) &&
    profile.accessMode === 'byok' && profile.modelIds.includes(model));
  const matches = profilesForModel.filter(profile => profile.enabled);
  if (matches.length > 1) return 'ambiguous' as const;
  if (!matches.length && profilesForModel.length) return 'unavailable' as const;
  const match = matches[0];
  if (match && isProvider(match.providerId)) return { providerId: match.providerId, accountId: match.id };
  return undefined;
}
