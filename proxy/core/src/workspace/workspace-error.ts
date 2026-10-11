/**
 * Workspace error with its HTTP status. Its own module so that services imported by runtime.ts can throw it without
 * importing runtime.ts back (that cycle broke the bundled TUI: module constants evaluated before their dependencies).
 */
export class WorkspaceError extends Error {
  readonly code:string;
  readonly status:400|403|404|409|422|429|503|502;
  readonly details?:unknown;
  constructor(code: string, status: 400|403|404|409|422|429|503|502 = 400, details?:unknown) { super(code); this.code=code;this.status=status;this.details=details; }
}
