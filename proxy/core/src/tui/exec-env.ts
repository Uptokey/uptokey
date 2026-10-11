/**
 * Uptokey TUI — Minimal environment for child processes.
 *
 * Hooks and shell commands no longer inherit the full parent environment
 * (which contains tokens, secrets and credentials). Only an allowlist of
 * variables needed for the OS, PATH resolution and temp folders is passed
 * through, plus the explicit UPTOKEY_HOOK_* context variables.
 */

const WINDOWS_KEYS = [
  "SystemRoot", "windir", "ComSpec", "PATHEXT", "PATH",
  "TEMP", "TMP", "APPDATA", "LOCALAPPDATA", "USERPROFILE",
  "HOMEDRIVE", "HOMEPATH", "PROGRAMFILES", "PROGRAMFILES(X86)",
  "NUMBER_OF_PROCESSORS", "OS", "PROCESSOR_ARCHITECTURE",
] as const;

const POSIX_KEYS = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR",
] as const;

export function minimalExecEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  const keys: readonly string[] = process.platform === "win32" ? WINDOWS_KEYS : POSIX_KEYS;
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === "string") env[key] = value;
  }
  env.TERM = "dumb";
  env.NO_COLOR = "1";
  return { ...env, ...extra };
}
