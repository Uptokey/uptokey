import type { OptionalProviderName, ProviderName } from "./types.ts";
import { isOptionalProvider, isProvider } from "./provider-registry.ts";
import { parseClientAudienceArgs, type ClientAudienceCommand } from "./client-audience-cli.ts";

export type LocalManagementCommand =
  | { kind: "provider_add"; provider: ProviderName }
  | { kind: "provider_configure_gemini" }
  | { kind: "provider_configure_optional"; provider: OptionalProviderName; endpointUrl: string; model: string }
  | { kind: "provider_revoke"; provider: ProviderName }
  | { kind: "client_create"; clientName: string }
  | { kind: "client_revoke"; clientId: string }
  | ClientAudienceCommand
  | { kind: "routing_set"; order: string };

export function parseLocalManagementCommand(args: readonly string[]): LocalManagementCommand | undefined {
  const [area, command, argument, ...extra] = args;
  if (area === "provider" && command === "add" && isProvider(argument) && extra.length === 0) return { kind: "provider_add", provider: argument };
  if (area === "provider" && command === "configure" && argument === "gemini" && extra.length === 0) return { kind: "provider_configure_gemini" };
  if (area === "provider" && command === "configure" && isOptionalProvider(argument) && extra.length === 2 && extra[0] && extra[1]) {
    return { kind: "provider_configure_optional", provider: argument, endpointUrl: extra[0], model: extra[1] };
  }
  if (area === "provider" && command === "revoke" && isProvider(argument) && extra.length === 0) return { kind: "provider_revoke", provider: argument };
  if (area === "client" && command === "create" && argument && extra.length === 0) return { kind: "client_create", clientName: argument };
  if (area === "client" && command === "revoke" && argument && extra.length === 0) return { kind: "client_revoke", clientId: argument };
  if (area === "client" && command === "audience") return parseClientAudienceArgs(args.slice(2));
  if (area === "routing" && command === "set" && argument && extra.length === 0) return { kind: "routing_set", order: argument };
  return undefined;
}
