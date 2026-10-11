/**
 * Parses terminal CLI options and starts the canonical frontend with the
 * caller's project and presentation preferences. Unsupported flags are rejected.
 */
import { resolve } from "node:path";
import { PACKAGE_VERSION } from "../version.ts";
import { adoptTuiServiceProfile, startSharedService } from "./service-start.ts";
import { discoverCoreUrl } from "./client.ts";
import { terminalHelp } from "./messages/terminal.ts";
import { terminalText } from './frontend/uptokey/integration-terminal.ts';
import { autoDetect, getLang, setLang, t, type Lang } from "./i18n.ts";

export interface TuiOptions {
  lang?: Lang;
  connect?: string;
  port?: number;
  project?: string;
  model?: string;
  resume?: string;
  cwd?: string;
  screenReader?: boolean;
  pipe?: boolean;
  theme?: string;
  temporary?: boolean;
  external?: boolean;
  /** Historical alias for the canonical interface. */
  next?: boolean;
  /** Optional positional project root. */
  targetPath?: string;
}

const KNOWN_FLAGS = new Set([
  "--port", "--project", "--model", "--resume", "--cwd", "--theme",
  "--screen-reader", "--pipe", "--temporary", "--external", "--next", "--autonomy", "--connect", "--lang", "--help", "-h", "--version", "-v",
]);

export const TUI_VERSION = PACKAGE_VERSION;

export function parseArgs(args: readonly string[]): TuiOptions {
  const opts: TuiOptions = {};
  let positional: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("-")) {
      if (positional !== undefined) throw new Error(`unexpected_argument:${arg}`);
      positional = arg;
      continue;
    }
    if (!KNOWN_FLAGS.has(arg)) throw new Error(`unknown_option:${arg}`);
    const next = args[i + 1];
    const needsValue = ["--port", "--project", "--model", "--resume", "--cwd", "--theme", "--connect", "--lang"].includes(arg);
    if (needsValue && (next === undefined || next.startsWith("--"))) throw new Error(`missing_value:${arg}`);
    if (arg === "--port") { opts.port = Number.parseInt(next!, 10); i++; }
    else if (arg === "--project") { opts.project = next; i++; }
    else if (arg === "--model") { opts.model = next; i++; }
    else if (arg === "--resume") { opts.resume = next; i++; }
    else if (arg === "--cwd") { opts.cwd = resolve(next!); i++; }
    else if (arg === "--theme") { opts.theme = next; i++; }
    else if (arg === "--connect") { opts.connect = next; i++; }
    else if (arg === "--lang") { opts.lang = autoDetect(["--lang", next!], {}); i++; }
    else if (arg === "--screen-reader") { opts.screenReader = true; }
    else if (arg === "--pipe") { opts.pipe = true; }
    else if (arg === "--temporary") { opts.temporary = true; }
    else if (arg === "--external") { opts.external = true; }
    else if (arg === "--next") { opts.next = true; }
    else if (arg === "--autonomy") { process.env.UPTOKEY_TUI_AUTONOMY = "1"; }
    else if (arg === "--help" || arg === "-h") { printHelp(); process.exit(0); }
    else if (arg === "--version" || arg === "-v") { process.stdout.write(`uptokey ${TUI_VERSION}\n`); process.exit(0); }
  }
  if (positional !== undefined) opts.targetPath = resolve(positional);
  return opts;
}

function printHelp(): void { process.stdout.write(terminalHelp(getLang())); }

export async function runTui(args: readonly string[]): Promise<void> {
  setLang(autoDetect([...args], process.env));
  let opts: TuiOptions;
  try { opts = parseArgs(args); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const text = message.startsWith('unknown_option:') ? t('cli_unknown_option', { option: message.slice(15) })
      : message.startsWith('missing_value:') ? t('cli_missing_value', { option: message.slice(14) }) : message;
    process.stderr.write(`${t('cli_error_prefix', { text })}\n`);
    process.exitCode = 2; return;
  }
  if (opts.cwd && opts.targetPath && opts.cwd !== opts.targetPath) {
    process.stderr.write(`${t('cli_error_cwd_positional')}\n`); process.exitCode = 2; return;
  }
  const cwd = opts.cwd ?? opts.targetPath ?? process.cwd();
  setLang(opts.lang ?? autoDetect([], process.env));
  if (opts.pipe) {
    // A caller that supplies a port is already binding the TUI to an
    // explicit core (CI relays and embedded clients use this path). Do not
    // inspect or relaunch the Quimera development profile in that mode; the
    // pipe contract must report the core/identity result itself.
    if (opts.port === undefined) await adoptTuiServiceProfile(cwd);
    const { runPipe } = await import('./pipe.ts');
    process.exitCode = await runPipe({ port: opts.port, model: opts.model, project: opts.project, cwd, temporary: opts.temporary, external: opts.external });
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(`${t('cli_error_interactive_tty')}\n`); process.exitCode = 3; return;
  }
  await adoptTuiServiceProfile(cwd);
  try { await startSharedService(discoverCoreUrl(opts.port), cwd); }
  catch {
    process.stderr.write(`${t('svc_start_failed')}\n`); process.exitCode = 3; return;
  }
  const { runFrontend } = await import('./frontend-launcher.ts');
  let launchArgs = args.filter(arg => arg !== '--next');
  for (;;) {
    let handoff = '';
    const code = await runFrontend(launchArgs, { onHandoff: text => { handoff = text; } });
    if (code === 75 && handoff) {
      try {
        const mode = JSON.parse(handoff) as { screenReader?: boolean; conversationId?: string };
        if (typeof mode.screenReader === 'boolean') {
          launchArgs = launchArgs.filter((arg, index, all) => arg !== '--screen-reader' && arg !== '--resume' && all[index - 1] !== '--resume');
          if (mode.screenReader) launchArgs.push('--screen-reader');
          if (mode.conversationId) launchArgs.push('--resume', mode.conversationId);
          continue;
        }
      } catch { /* A malformed handoff cannot choose another runtime or identity. */ }
    }
    if (code === null) {
      process.stderr.write(`${terminalText('frontend_missing')}\n`);
      process.exitCode = 3;
    } else process.exitCode = code;
    return;
  }
}
