/** Native clipboard boundary for real terminal journeys; byte assertions do not trust terminal OSC52 output. */
import { spawn } from "node:child_process";
import { join } from "node:path";

function commands(read) {
  if (process.platform === "win32") return [{ file: join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-Command", "$ErrorActionPreference='Stop'; [Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); " +
      (read ? "[Console]::Out.Write((Get-Clipboard -Raw))" : "Set-Clipboard -Value ([Console]::In.ReadToEnd())")] }];
  if (process.platform === "darwin") return [{ file: read ? "/usr/bin/pbpaste" : "/usr/bin/pbcopy", args: [] }];
  return [
    ...(process.env.WAYLAND_DISPLAY ? [{ file: read ? "wl-paste" : "wl-copy", args: read ? ["--no-newline"] : ["--type", "text/plain;charset=utf-8"] }] : []),
    { file: "xclip", args: ["-selection", "clipboard", ...(read ? ["-o"] : [])] },
    { file: "xsel", args: ["--clipboard", read ? "--output" : "--input"] },
  ];
}

function run(command, input) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(command.file, command.args, { windowsHide: true, shell: false, stdio: ["pipe", "pipe", "ignore"] }); }
    catch { reject(new Error("native clipboard probe could not launch")); return; }
    const output = []; let size = 0, settled = false;
    const finish = (error) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(Buffer.concat(output)); };
    const timer = setTimeout(() => { child.kill(); finish(new Error("native clipboard probe timed out")); }, 5000);
    child.stdout.on("data", (chunk) => { size += chunk.length; if (size > 1024 * 1024) { child.kill(); finish(new Error("native clipboard exceeds journey limit")); } else output.push(chunk); });
    child.once("error", () => finish(new Error("native clipboard probe unavailable")));
    child.once("close", (code) => finish(code === 0 ? null : new Error("native clipboard probe failed")));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

async function nativeClipboard(read, input) {
  for (const command of commands(read)) {
    try { return await run(command, input); }
    catch (error) { if (process.platform === "win32" || process.platform === "darwin") throw error; }
  }
  throw new Error("no system clipboard backend for this journey");
}
export const readSystemClipboard = () => nativeClipboard(true);
export const writeSystemClipboard = (text) => nativeClipboard(false, Buffer.from(text, "utf8"));
