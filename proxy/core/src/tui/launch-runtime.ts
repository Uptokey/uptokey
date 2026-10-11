/** Runtime facts captured by the core entrypoint and passed to the frontend.
 * Kept separate from path-resolution modules so the compiled graph remains
 * safe to import as a library. */
import { realpathSync } from "node:fs";

export function currentCoreLaunchRuntime(
  runtime: { executable: string; entry?: string; execArgv: readonly string[] } = { executable: process.execPath, entry: process.argv[1], execArgv: process.execArgv },
  resolveEntry: (entry: string) => string = realpathSync,
): { executable: string; entry?: string; execArgv: readonly string[] } {
  let entry = runtime.entry;
  // POSIX npm bins are symlinks named `uptokey`, while Node argv[1] retains
  // that name. Resolve its target before deciding this is a compiled executable.
  if (entry) {
    try { entry = resolveEntry(entry); }
    catch { /* An unavailable entry stays unavailable; never search PATH. */ }
  }
  return { ...runtime, entry };
}
