/** Local development profile of the copied application, never legacy runtime. */
export const QUIMERA_CONTROL_PLANE_ORIGIN = "http://127.0.0.1:18787";

export function quimeraControlPlaneOrigin(env: NodeJS.ProcessEnv = process.env): string {
  if (env.UPTOKEY_CONTROL_PLANE_ORIGIN !== undefined) throw new Error("quimera_legacy_control_origin_forbidden");
  if (env.UPTOKEY_QUIMERA_CONTROL_PLANE_ORIGIN !== undefined && env.UPTOKEY_QUIMERA_CONTROL_PLANE_ORIGIN !== QUIMERA_CONTROL_PLANE_ORIGIN) {
    throw new Error("quimera_control_origin_forbidden");
  }
  return QUIMERA_CONTROL_PLANE_ORIGIN;
}

export function assertQuimeraCommand(args: readonly string[]): void {
  if (args[0] === "update" || (args[0] === "models" && args[1] === "install") || args[0] === "security" || args.some(arg => arg.startsWith("--update-child=") || arg.startsWith("--rollback-child="))) {
    throw new Error("quimera_global_operation_disabled");
  }
}
