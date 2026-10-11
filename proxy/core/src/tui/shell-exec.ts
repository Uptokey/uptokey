/**
 * Classifies command risk and captures sanitized output from supervised
 * execution with a minimal environment, timeouts and process-tree cleanup.
 */
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { minimalExecEnv } from "./exec-env.ts";
import { sanitizeTerminalOutput } from "./sanitize.ts";

/**
 * Sanitized view of external command output: strips OSC/CSI injection
 * before anything reaches the transcript or stream buffer (S3).
 */
export function sanitizeShellOutput(text: string): string {
  return sanitizeTerminalOutput(text);
}

export type CommandRisk = "safe" | "moderate" | "dangerous";

const SAFE_COMMANDS = new Set([
  "ls", "dir", "cat", "type", "head", "tail", "wc", "grep", "find",
  "echo", "pwd", "whoami", "date", "git status", "git log", "git diff",
  "git branch", "node --version", "npm --version", "npx tsc --noEmit",
  "npm test", "npm run test", "npm run build", "npm run lint",
]);

const DANGEROUS_PATTERNS = [
  /\brm\s+-rf?\b/, /\bdel\s+\/[sS]\b/, /\bformat\b/, /\bmkfs\b/,
  /\bcurl\b.*\|\s*(?:bash|sh)/, /\bwget\b.*\|\s*(?:bash|sh)/,
  /\bsudo\b/, /\bchmod\s+777\b/, /\bdd\s+if=/, /\b>\s*\/dev\//,
  /\bkill\s+-9\b/, /\bshutdown\b/, /\breboot\b/,
  /DROP\s+TABLE/i, /DELETE\s+FROM/i, /TRUNCATE/i,
];

export function classifyCommand(command: string): CommandRisk {
  const trimmed = command.trim().toLowerCase();
  if (SAFE_COMMANDS.has(trimmed)) return "safe";
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) return "dangerous";
  }
  return "moderate";
}

export interface ShellResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  killed: boolean;
  duration: number;
}

export interface ShellExecution extends EventEmitter {
  kill(): void;
  readonly running: boolean;
  readonly result: Promise<ShellResult>;
}

/**
 * Execute a shell command with streaming output and timeout.
 */
export function executeCommand(
  command: string,
  options?: { cwd?: string; timeout?: number; maxOutput?: number },
): ShellExecution {
  const cwd = options?.cwd ?? process.cwd();
  const timeout = options?.timeout ?? 30_000;
  const maxOutput = options?.maxOutput ?? 1_000_000; // 1MB
  const startTime = Date.now();

  const emitter = new EventEmitter() as ShellExecution;
  let running = true;
  let stdoutBuf = "";
  let stderrBuf = "";

  // Minimal allowlisted environment: no parent secrets leak into commands.
  const childEnv = minimalExecEnv();

  // Use shell on Windows, direct on Unix. On POSIX the child gets its own
  // process group so kill() can terminate the whole tree.
  const isWindows = process.platform === "win32";
  const proc = spawn(isWindows ? "cmd.exe" : "/bin/sh", [isWindows ? "/c" : "-c", command], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
    detached: !isWindows,
    env: childEnv,
  });

  const killTree = (): void => {
    if (proc.pid === undefined) return;
    if (isWindows) {
      // taskkill /T walks the full child tree on Windows.
      spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      try {
        process.kill(-proc.pid, "SIGTERM");
      } catch {
        proc.kill("SIGTERM");
      }
    }
  };

  const result = new Promise<ShellResult>((resolve) => {
    proc.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      if (stdoutBuf.length < maxOutput) {
        stdoutBuf = (stdoutBuf + text).slice(0, maxOutput);
        emitter.emit("stdout", text);
      }
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      if (stderrBuf.length < maxOutput) {
        stderrBuf = (stderrBuf + text).slice(0, maxOutput);
        emitter.emit("stderr", text);
      }
    });

    proc.on("close", (code, signal) => {
      running = false;
      resolve({
        exitCode: code,
        stdout: stdoutBuf,
        stderr: stderrBuf,
        killed: signal !== null,
        duration: Date.now() - startTime,
      });
    });

    proc.on("error", (err) => {
      running = false;
      resolve({
        exitCode: -1,
        stdout: stdoutBuf,
        stderr: err.message,
        killed: false,
        duration: Date.now() - startTime,
      });
    });
  });

  Object.defineProperty(emitter, "running", { get: () => running });
  Object.defineProperty(emitter, "result", { get: () => result });
  (emitter as ShellExecution).kill = () => { killTree(); };

  return emitter;
}

/**
 * Format shell result for chat display. Output is sanitized: external
 * commands cannot inject ANSI/OSC sequences into the transcript (S3).
 */
export function formatShellResult(command: string, result: ShellResult): string {
  const status = result.exitCode === 0 ? "✓" : result.killed ? "⚡ killed" : `✗ exit ${result.exitCode}`;
  const duration = result.duration < 1000 ? `${result.duration}ms` : `${(result.duration / 1000).toFixed(1)}s`;

  const lines = [`\`\`\`\n$ ${command}\n`];
  const stdout = sanitizeShellOutput(result.stdout.trim());
  const stderr = sanitizeShellOutput(result.stderr.trim());
  if (stdout) lines.push(stdout);
  if (stderr) lines.push(`\n--- stderr ---\n${stderr}`);
  lines.push(`\n\`\`\`\n${status} (${duration})`);

  return lines.join("");
}
