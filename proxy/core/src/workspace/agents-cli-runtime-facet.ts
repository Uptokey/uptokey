/**
 * E2-14 runtime facet — thin adapter for WorkspaceRuntime.capabilitiesInfo merge.
 * Stateless modules for now; bind flag lets app mark the HTTP seam as wired.
 */

export function agentsCliCapabilityFacet() {
  return {
    agentsCli: {
      available: true,
      hash: "#integrations",
      verifiedProfiles: ["cline", "continue", "aider"] as const,
      copyGeneratesInstall: false,
      contractRevision: "e2-14.1",
    },
  };
}

/** Optional readiness flag — coordinator wires once after bindAutomationService. */
let ready = false;

export function bindAgentsCliReady(): void {
  ready = true;
}

export function isAgentsCliReady(): boolean {
  return ready;
}
