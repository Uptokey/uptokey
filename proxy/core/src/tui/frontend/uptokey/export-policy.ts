import { getBackend } from "./backend/registry.ts"
import { selectionUi } from "./integration-selection.ts"

export class TemporaryExportError extends Error {
  readonly code = "temporary_export_forbidden"
  constructor() { super(selectionUi("temporary_export_forbidden")); this.name = "TemporaryExportError" }
}

export class ExportPolicyUnavailableError extends Error {
  readonly code = "export_policy_unavailable"
  constructor() { super(selectionUi("export_policy_unavailable")); this.name = "ExportPolicyUnavailableError" }
}

/** All frontend sinks consult the controller's current storage policy, including after a modal wait. */
export function assertFrontendExportAllowed(temporary?: boolean): void {
  if (temporary === undefined) {
    try { temporary = getBackend().temporary } catch { throw new ExportPolicyUnavailableError() }
  }
  if (temporary) throw new TemporaryExportError()
}
