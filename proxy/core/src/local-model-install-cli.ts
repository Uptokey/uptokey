import {createInterface} from "node:readline/promises";
import {stdin, stdout, stderr} from "node:process";
import {installLocalModel, validInstallModel} from "./local-model-install.ts";

export async function installLocalModelCli(model: string | undefined, extra: string[]): Promise<void> {
  if (!validInstallModel(model) || extra.length) {
    stderr.write("Usage: uptokey models install <model>\n"); process.exitCode = 1; return;
  }
  if (!stdin.isTTY || !stdout.isTTY) {
    stderr.write("Open an interactive terminal to review and confirm the model download.\n"); process.exitCode = 1; return;
  }
  stdout.write(`Download ${model} through Ollama on this computer.\nThis uses network bandwidth and disk space. Check the model's publisher and license at https://ollama.com/library before continuing.\nNo model will be run or added to Uptokey routing. Ollama also supports cloud-backed models; downloading an entry alone does not prove local execution.\n`);
  const terminal = createInterface({input: stdin, output: stdout});
  let confirmation: string;
  try { confirmation = await terminal.question('Type DOWNLOAD to continue: '); } finally { terminal.close(); }
  if (confirmation.trim() !== "DOWNLOAD") { stdout.write("Download not started.\n"); return; }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  let last = "", lastAt = 0;
  try {
    await installLocalModel(model, {confirmed: true, signal: controller.signal, onProgress: progress => {
      const percent = progress.totalBytes ? Math.floor((progress.completedBytes ?? 0) / progress.totalBytes * 100) : undefined;
      const message = `${progress.stage}${percent === undefined ? "" : ` · current layer ${percent}%`}`;
      if (message !== last && (Date.now() - lastAt >= 500 || progress.stage === "complete")) {
        stdout.write(`${message}\n`); last = message; lastAt = Date.now();
      }
    }});
    stdout.write("Download confirmed by Ollama. In the dashboard, choose Find installed models, then configure the model you want to use.\n");
  } catch (error) {
    const code = error instanceof Error ? error.message : "install_failed";
    stderr.write(code === "ollama_unreachable" ? "Ollama did not respond. Install or open Ollama, then try again.\n" :
      code === "install_interrupted" ? "Stopped waiting for the download. Ollama may retain partial files; check installed models before retrying.\n" :
      code === "model_not_found" ? "Model not found. Check its name in the Ollama library.\n" : "Ollama did not confirm a completed download. Check the model name, disk space and local Ollama service.\n");
    process.exitCode = 1;
  } finally { process.removeListener("SIGINT", stop); }
}
