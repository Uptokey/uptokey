import { execFile, spawn } from "node:child_process"
import { readFile, rm } from "node:fs/promises"
import { platform, release, tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { ClipboardWriteError, writeClipboard } from "../../../clipboard.ts"
import { assertFrontendExportAllowed, ExportPolicyUnavailableError, TemporaryExportError } from "../../uptokey/export-policy.ts"
import { selectionUi } from "../../uptokey/integration-selection.ts"

const exec = promisify(execFile)

function command(command: string, args: string[] = [], input?: string) {
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(command, args, { stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"] })
    const output: Buffer[] = []
    child.on("error", reject)
    child.stdout?.on("data", (chunk: Buffer) => output.push(chunk))
    child.on("close", (code) => {
      if (code === 0) return resolve(Buffer.concat(output))
      reject(new Error(`${command} exited with code ${code}`))
    })
    if (input !== undefined) child.stdin?.end(input)
  })
}

export function writeOsc52(text: string): boolean {
  if (!process.stdout.isTTY) return false
  const sequence = `\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`
  const passthrough = `\x1bPtmux;\x1b${sequence}\x1b\\`
  process.stdout.write(process.env.TMUX ? sequence + passthrough : process.env.STY ? passthrough : sequence)
  return true
}

export async function read() {
  if (platform() === "darwin") {
    const file = path.join(tmpdir(), "opencode-clipboard.png")
    try {
      await exec("osascript", [
        "-e",
        'set imageData to the clipboard as "PNGf"',
        "-e",
        `set fileRef to open for access POSIX file "${file}" with write permission`,
        "-e",
        "set eof fileRef to 0",
        "-e",
        "write imageData to fileRef",
        "-e",
        "close access fileRef",
      ])
      return { data: (await readFile(file)).toString("base64"), mime: "image/png" }
    } catch {
      // Fall through to text clipboard.
    } finally {
      await rm(file, { force: true }).catch(() => {})
    }
  }

  if (platform() === "win32" || release().includes("WSL")) {
    const script =
      "Add-Type -AssemblyName System.Windows.Forms; $img = [System.Windows.Forms.Clipboard]::GetImage(); if ($img) { $ms = New-Object System.IO.MemoryStream; $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); [System.Convert]::ToBase64String($ms.ToArray()) }"
    const image = await command("powershell.exe", ["-NonInteractive", "-NoProfile", "-command", script]).catch(() =>
      Buffer.alloc(0),
    )
    if (image.length) return { data: image.toString().trim(), mime: "image/png" }
  }

  if (platform() === "linux") {
    const wayland = await command("wl-paste", ["-t", "image/png"]).catch(() => Buffer.alloc(0))
    if (wayland.length) return { data: wayland.toString("base64"), mime: "image/png" }
    const x11 = await command("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]).catch(() =>
      Buffer.alloc(0),
    )
    if (x11.length) return { data: x11.toString("base64"), mime: "image/png" }
  }

  const { default: clipboardy } = await import("clipboardy")
  const text = await clipboardy.read().catch(() => undefined)
  if (text) return { data: text, mime: "text/plain" }
}

export function copyCommand(
  os: NodeJS.Platform,
  wayland: boolean,
  has: (name: string) => boolean,
): string[] | undefined {
  if (os === "darwin" && has("osascript")) return ["osascript"]
  if (os === "linux" && wayland && has("wl-copy")) return ["wl-copy"]
  if (os === "linux" && has("xclip")) return ["xclip", "-selection", "clipboard"]
  if (os === "linux" && has("xsel")) return ["xsel", "--clipboard", "--input"]
  if (os === "win32" && has("powershell.exe")) {
    return [
      "powershell.exe",
      "-NonInteractive",
      "-NoProfile",
      "-Command",
      "[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())",
    ]
  }
}

export class TerminalClipboardUnconfirmedError extends Error {
  readonly code = "clipboard_unconfirmed"
  constructor() { super(selectionUi("clipboard_unconfirmed")); this.name = "TerminalClipboardUnconfirmedError" }
}

export function clipboardErrorMessage(error: unknown): string {
  if (error instanceof TemporaryExportError) return selectionUi("temporary_export_forbidden")
  if (error instanceof ExportPolicyUnavailableError) return selectionUi("export_policy_unavailable")
  if (error instanceof TerminalClipboardUnconfirmedError) return selectionUi("clipboard_unconfirmed")
  if (error instanceof ClipboardWriteError) return selectionUi(error.code)
  return selectionUi("clipboard_write_failed")
}

/** Native success is confirmed by its exit status. OSC 52 has no acknowledgement. */
export async function writeVerifiedClipboard(text: string, options: {
  native?: (text: string) => Promise<void>
  terminal?: (text: string) => boolean
  assertAllowed?: () => void
} = {}): Promise<void> {
  const assertAllowed = options.assertAllowed ?? assertFrontendExportAllowed
  assertAllowed()
  try {
    await (options.native ?? writeClipboard)(text)
  } catch (error) {
    assertAllowed()
    if (error instanceof ClipboardWriteError && error.code === "clipboard_unavailable" &&
      (options.terminal ?? writeOsc52)(text)) throw new TerminalClipboardUnconfirmedError()
    throw error
  }
}

export async function write(text: string): Promise<void> {
  try { await writeVerifiedClipboard(text) }
  catch (error) {
    // Never leak copied text, native stderr or process command lines in the interface.
    if (error instanceof Error) error.message = clipboardErrorMessage(error)
    throw error
  }
}
