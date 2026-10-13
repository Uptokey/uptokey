/** Real PTY (ConPTY on Windows) + xterm/headless screen model, shared by the terminal-frontend journeys. */
import { setTimeout as delay } from "node:timers/promises";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export function findExecutable(name) {
  if (process.env[`UPTOKEY_${name.toUpperCase()}`]) return process.env[`UPTOKEY_${name.toUpperCase()}`];
  const exts = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const dir of (process.env.PATH ?? process.env.Path ?? "").split(delimiter)) {
    for (const ext of exts) { const candidate = join(dir, name + ext); if (existsSync(candidate)) return candidate; }
  }
  throw new Error(`${name} not found on PATH`);
}

export async function openPty({ file, args = [], cwd, env, cols = 120, rows = 36 }) {
  const [{ default: pty }, { default: xterm }] = await Promise.all([import("@lydell/node-pty"), import("@xterm/headless")]);
  const term = new xterm.Terminal({ cols, rows, allowProposedApi: true, scrollback: 5000 });
  let parsed = Promise.resolve();
  let raw = "";
  let exitCode = null;
  let exited = false;
  let firstDataAt = null;
  const screenObservers = new Set();
  const child = pty.spawn(file, args, { name: "xterm-256color", cols, rows, cwd, env, useConpty: true });
  child.onData((data) => {
    const receivedAt = performance.now();
    if (firstDataAt === null) firstDataAt = receivedAt;
    raw += data;
    parsed = parsed.then(() => new Promise((done) => {
      const parseStartedAt = performance.now();
      term.write(data, () => {
        const parsedAt = performance.now();
        const timing = { receivedAt, parseStartedAt, parsedAt, bytes: Buffer.byteLength(data) };
        for (const observer of screenObservers) observer(timing);
        done();
      });
    }));
  });
  child.onExit((event) => { exitCode = event.exitCode; exited = true; });
  const screen = () => Array.from({ length: term.rows }, (_, row) => term.buffer.active.getLine(term.buffer.active.viewportY + row)?.translateToString(true) ?? "").join("\n");
  const full = () => { const lines = []; for (let i = 0; i < term.buffer.active.length; i++) lines.push(term.buffer.active.getLine(i)?.translateToString(true) ?? ""); return lines.join("\n"); };
  async function until(check, message, timeoutMs = 20000) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      await parsed;
      if (await check()) return;
      if (exited || Date.now() > end) throw new Error(`${message}\n--- screen ---\n${screen()}`);
      await delay(40);
    }
  }
  async function send(bytes, settle = 90) { child.write(bytes); await delay(settle); await parsed; }
  return {
    term, child, screen, full, until, send,
    observeScreen(observer) { screenObservers.add(observer); return () => screenObservers.delete(observer); },
    raw: () => raw,
    firstDataAt: () => firstDataAt,
    exited: () => ({ exited, exitCode }),
    resize(c, r) { child.resize(c, r); term.resize(c, r); },
    async close() { try { child.kill(); } catch { /* already gone */ } await delay(100); term.dispose(); },
  };
}
