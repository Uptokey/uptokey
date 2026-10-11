/**
 * E2-13 runtime facet — thin adapter for WorkspaceRuntime.capabilitiesInfo merge.
 * Does not fork executor; exposes automations capability descriptor only.
 */

import type { AutomationService } from "./automation-service.ts";
import { AUTOMATION_CONTRACT_REVISION } from "./automation-w0-delta.ts";

export function automationsCapabilityFacet(service?: AutomationService) {
  return {
    automations: {
      available: !!service,
      contractRevision: AUTOMATION_CONTRACT_REVISION,
      hash: "#automations",
      channels: ["brevo", "resend", "slack"] as const,
      miniChatAuthorizesExternalSend: false,
      chains: !!service?.chainExecutor,
      scheduledExecution: !!service?.prepareScheduleGrant,
      scheduledExecutionRequiresGrant: true,
      scheduledPreparation: !!service,
      externalDelivery: !!service?.delivery,
      serviceBound: !!service,
    },
  };
}

/** Optional singleton holder for HTTP/CLI inject — coordinator wires once. */
let bound: AutomationService | undefined;

export function bindAutomationService(service: AutomationService): void {
  bound = service;
}

export function getBoundAutomationService(): AutomationService | undefined {
  return bound;
}
