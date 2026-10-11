import type { ReadStream, WriteStream } from "node:tty";
import { containProcessOutput, writeProcessOutput } from "./process-output.ts";

export async function readTerminalSecret(
  label: string,
  maxLength: number,
  input: ReadStream = process.stdin,
  output: WriteStream = process.stdout
): Promise<string> {
  if (!Number.isSafeInteger(maxLength) || maxLength < 1) throw new Error("invalid_secret_limit");
  if (!input.isTTY) throw new Error("interactive_terminal_required");
  containProcessOutput(output);
  try {
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
  } catch {
    restoreInput(input);
    throw new Error("interactive_terminal_unavailable");
  }

  return await new Promise((resolve, reject) => {
    let value = "";
    let finished = false;
    const settle = (result: () => void): void => {
      if (finished) return;
      finished = true;
      cleanup();
      result();
    };
    const onData = (chunk: string): void => {
      for (const character of chunk) {
        if (finished) break;
        if (character === "\u0003") settle(() => reject(new Error("Cancelado.")));
        else if (character === "\r" || character === "\n") settle(() => { writeProcessOutput(output, "\n"); resolve(value); });
        else if (character === "\u007f" || character === "\b") value = removeLastCodePoint(value);
        else if (character >= " ") {
          if (value.length + character.length > maxLength) settle(() => reject(new Error(`A chave excede ${maxLength} caracteres.`)));
          else value += character;
        }
      }
    };
    const onEnd = (): void => settle(() => reject(new Error("interactive_terminal_closed")));
    const onError = (): void => settle(() => reject(new Error("interactive_terminal_unavailable")));
    const onOutputError = (): void => settle(() => reject(new Error("interactive_terminal_unavailable")));
    const cleanup = (): void => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
      output.off("error", onOutputError);
      restoreInput(input);
    };
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
    output.once("error", onOutputError);
    try { output.write(label); } catch { onOutputError(); }
  });
}

function removeLastCodePoint(value: string): string {
  if (!value) return value;
  const last = value.charCodeAt(value.length - 1);
  const previous = value.length > 1 ? value.charCodeAt(value.length - 2) : 0;
  const width = last >= 0xDC00 && last <= 0xDFFF && previous >= 0xD800 && previous <= 0xDBFF ? 2 : 1;
  return value.slice(0, -width);
}

function restoreInput(input: ReadStream): void {
  try { input.setRawMode(false); } catch { /* restauração best-effort */ }
  try { input.pause(); } catch { /* restauração best-effort */ }
}
