import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildWindowsPackage } from "./build-windows-package.mjs";
import { spawnSync } from "node:child_process";

const distDir = resolve("dist");
mkdirSync(distDir, { recursive: true });

const devPublicKeyPath = resolve(distDir, "dev-update-public.pem");
const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
writeFileSync(devPublicKeyPath, pair.publicKey.export({ type: "spki", format: "pem" }), { mode: 0o600 });

process.env.UPTOKEY_UPDATE_PUBLIC_KEY_PATH = devPublicKeyPath;
process.env.UPTOKEY_UPDATE_ORIGIN = "https://updates.uptokey.test";
process.env.UPTOKEY_BUILD_VERSION = "0.1.0-dev";

console.log("Compilando pacote Windows em dist/...");
const layout = buildWindowsPackage(distDir);
console.log("Executável gerado:", layout.executable);
console.log("Helper de update gerado:", layout.updateHelper);

console.log("Testando execução de", layout.executable, "...");
const testRun = spawnSync(layout.executable, ["license"], { encoding: "utf8", windowsHide: true });
if (testRun.status === 0) {
  console.log("Sucesso! Executável respondeu corretamente.");
} else {
  console.error("Falha ao executar:", testRun.stderr || testRun.stdout);
  process.exitCode = 1;
}
