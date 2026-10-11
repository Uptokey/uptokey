import { tuiEvidenceDirectory } from "./lib/tui-evidence.mjs";
import { resolve } from "node:path";
import { execSync } from 'child_process';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import test from 'node:test';
import assert from 'node:assert';

const logDir = tuiEvidenceDirectory(resolve(process.cwd()));
mkdirSync(logDir, { recursive: true });
const logFile = join(logDir, 'e9-pack-linux.log');

function log(msg) {
  console.log(msg);
  writeFileSync(logFile, msg + '\n', { flag: 'a' });
}

writeFileSync(logFile, '');

let runner = null;
try {
  execSync('docker --version', { stdio: 'ignore' });
  runner = 'docker';
} catch (e) {
  try {
    execSync('podman --version', { stdio: 'ignore' });
    runner = 'podman';
  } catch (e2) {}
}

test('Pack and verify Linux container', (t) => {
  if (!runner) {
    log('runner_unavailable: Docker/Podman não encontrado.');
    t.skip('Docker/Podman não encontrado');
    return;
  }

  log(`Usando runner: ${runner}`);

  log('Empacotando proxy/core...');
  const packOutput = execSync('npm pack', { encoding: 'utf8' }).trim();
  const tarballLines = packOutput.split('\n');
  const tarballName = tarballLines[tarballLines.length - 1].trim();
  log(`Tarball criado: ${tarballName}`);

  const tarballPath = join(process.cwd(), tarballName);
  const containerDest = '/pkg/' + tarballName;
  
  // Instala e verifica a versão
  const installCmd = `${runner} run --rm -v "${tarballPath}:${containerDest}" node:22-bookworm-slim bash -c "npm install -g ${containerDest} && uptokey tui --version"`;
  log(`Executando instalação: ${installCmd}`);
  execSync(installCmd, { stdio: 'inherit' });

  // Teste determinístico para exit code 3 (core_unavailable)
  const pipeCmd3 = `${runner} run --rm -v "${tarballPath}:${containerDest}" node:22-bookworm-slim bash -c "npm install -g ${containerDest} >/dev/null 2>&1 && echo '' | UPTOKEY_TUI_TOKEN=invalid uptokey tui --pipe --cwd /tmp"`;
  log(`Executando pipe test (code 3): ${pipeCmd3}`);
  
  let err3 = null;
  try {
    execSync(pipeCmd3, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    err3 = e;
  }
  assert.ok(err3, 'A execução deveria falhar (code 3)');
  assert.equal(err3.status, 3, `Exit code deve ser 3, recebido: ${err3.status}`);
  let jsonEvent3;
  try {
    const lines = (err3.stdout?.toString() || '').trim().split('\n');
    jsonEvent3 = JSON.parse(lines[lines.length - 1]);
  } catch (parseErr) {
    assert.fail('Não foi possível fazer parse do JSONL no stdout (code 3)');
  }
  assert.equal(jsonEvent3.code, 'core_unavailable');

  // Teste determinístico para exit code 4 (identity_unavailable)
  // O mock é montado como arquivo para não depender de três camadas de quoting
  // (cmd.exe -> shell do runner -> bash), que alteravam o programa JavaScript no Windows.
  const mockServerPath = join(logDir, 'identity-mock.cjs');
  writeFileSync(mockServerPath, `const http = require("http");
http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/local/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }
  res.writeHead(401, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { type: "unauthorized" } }));
}).listen(21435, "127.0.0.1");
`);
  const pipeCmd4 = `${runner} run --rm -v "${tarballPath}:${containerDest}" -v "${mockServerPath}:/pkg/identity-mock.cjs" node:22-bookworm-slim bash -c "npm install -g ${containerDest} >/dev/null 2>&1 && (node /pkg/identity-mock.cjs & sleep 1) && echo '' | UPTOKEY_TUI_TOKEN=invalid uptokey tui --pipe --cwd /tmp"`;
  log(`Executando pipe test (code 4): ${pipeCmd4}`);
  
  let err4 = null;
  try {
    execSync(pipeCmd4, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    err4 = e;
  }
  assert.ok(err4, 'A execução deveria falhar (code 4)');
  assert.equal(err4.status, 4, `Exit code deve ser 4, recebido: ${err4.status}`);
  let jsonEvent4;
  try {
    const lines = (err4.stdout?.toString() || '').trim().split('\n');
    jsonEvent4 = JSON.parse(lines[lines.length - 1]);
  } catch (parseErr) {
    assert.fail('Não foi possível fazer parse do JSONL no stdout (code 4)');
  }
  assert.equal(jsonEvent4.code, 'identity_unavailable');
  
  log('Artefato e protocolo determinísticos verificados com sucesso.');
});
