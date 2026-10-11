#!/usr/bin/env node
// Preparação REPRODUTÍVEL e verificada do adaptador DAP externo (Microsoft js-debug, MIT).
//
// Origem: https://github.com/microsoft/vscode-js-debug (licença MIT).
// Revisão fixada: v1.140.0 (release 394877600, 23/09/2026).
// Artefato: js-debug-dap-v1.140.0.tar.gz — sha256 declarado pelo GitHub no release.
//
// Garantias:
//  - o tar baixado é validado pelo hash ANTES de qualquer gravação;
//  - a extração lista o tar e rejeita caminhos absolutos, '..' e links;
//  - o staging fica em diretório IRMÃO (vendor/.js-debug-staging-*), e só é
//    promovido a vendor/js-debug após verificação completa; a instalação válida
//    anterior é preservada e restaurada em caso de falha (rollback);
//  - RECORD.json registra o hash de CONTEÚDO de cada arquivo instalado;
//  - --check verifica os arquivos E seu conteúdo (manifesto sozinho não prova);
//  - a única transformação local legítima é o package.json com type:commonjs
//    (o bundle upstream usa require), distinguida dos bytes upstream no RECORD.
//
// Uso:
//   node scripts/prepare-js-debug.mjs           prepara/atualiza vendor/js-debug
//   node scripts/prepare-js-debug.mjs --check   verifica a instalação atual (falha fechado)
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, renameSync, cpSync, statSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const TAG = 'v1.140.0';
const ASSET = `js-debug-dap-${TAG}.tar.gz`;
const ASSET_URL = `https://github.com/microsoft/vscode-js-debug/releases/download/${TAG}/${ASSET}`;
const ASSET_SHA256 = '27dab92937ec1ab35821ae955aac867544fe06a1b6307229049f2d789af10968';
const ORIGIN = 'https://github.com/microsoft/vscode-js-debug';
const LICENSE = 'MIT';
// Arquivos essenciais do artefato (dentro do diretório de topo 'js-debug/').
const EXPECTED_FILES = ['src/dapDebugServer.js', 'LICENSE'];
// Transformação local legítima (não é byte upstream): o bundle usa require (CJS).
const CJS_PACKAGE_JSON = JSON.stringify({ name: 'uptokey-vendor-js-debug', private: true, type: 'commonjs' }, null, 2) + '\n';

const here = dirname(fileURLToPath(import.meta.url));
const coreDir = resolve(here, '..');
const vendorDir = join(coreDir, 'vendor', 'js-debug');
const recordFile = join(vendorDir, 'RECORD.json');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const sha256File = (path) => sha256(readFileSync(path));

function recordPayload(fileHashes) {
  return JSON.stringify({
    schema: 'uptokey-vendor-record-v1',
    kind: 'dap-adapter',
    origin: ORIGIN,
    revision: TAG,
    license: LICENSE,
    asset: ASSET,
    assetSha256: ASSET_SHA256,
    localTransform: { 'package.json': 'type=commonjs (bundle upstream usa require)' },
    files: Object.fromEntries(Object.entries(fileHashes).sort(([a], [b]) => a.localeCompare(b))),
    preparedAt: new Date().toISOString(),
    note: 'Adaptador externo Microsoft js-debug (MIT). Usado como processo filho, nunca transplantado.',
  }, null, 2);
}

function fail(message) { console.error(`js-debug: ${message}`); process.exit(1); }

function check() {
  if (!existsSync(recordFile)) fail(`VENDOR AUSENTE — ${recordFile} não existe. Prepare com: node scripts/prepare-js-debug.mjs`);
  let declared;
  try { declared = JSON.parse(readFileSync(recordFile, 'utf8')); } catch { fail('REGISTRO ilegível (JSON inválido).'); }
  if (declared.assetSha256 !== ASSET_SHA256 || declared.revision !== TAG) fail('REGISTRO incompatível com a revisão fixada.');
  const files = declared.files;
  if (!files || typeof files !== 'object') fail('REGISTRO sem inventário de arquivos.');
  for (const [rel, hash] of Object.entries(files)) {
    const abs = join(vendorDir, ...rel.split('/'));
    if (!existsSync(abs)) fail(`ARQUIVO AUSENTE — ${rel} não existe na instalação.`);
    const actual = sha256File(abs);
    if (actual !== hash) fail(`CONTEÚDO DIVERGE — ${rel}: ${actual.slice(0, 16)}… ≠ ${String(hash).slice(0, 16)}… (corrupção/cópia parcial).`);
  }
  const cjs = join(vendorDir, 'package.json');
  if (!existsSync(cjs)) fail('TRANSFORMAÇÃO LOCAL ausente (package.json type=commonjs).');
  const cjsContent = readFileSync(cjs, 'utf8');
  if (cjsContent !== CJS_PACKAGE_JSON) fail('package.json local divergente do esperado.');
  console.log(`js-debug ok: ${declared.revision} (${declared.license}), ${Object.keys(files).length} arquivos com conteúdo conferido.`);
  process.exit(0);
}

if (process.argv.includes('--check')) check();

async function downloadBytes(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) fail(`download falhou (${response.status}) para ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

function listTarEntries(tarBin, archive, staging) {
  const listing = spawnSync(tarBin, ['-tzf', archive], { windowsHide: true, encoding: 'utf8' });
  if (listing.status !== 0) fail('falha ao listar o artefato.');
  const entries = listing.stdout.split(/\r?\n/).filter(Boolean);
  const verb = spawnSync(tarBin, ['-tvzf', archive], { windowsHide: true, encoding: 'utf8' });
  const verbose = verb.status === 0 ? verb.stdout.split(/\r?\n/).filter(Boolean) : [];
  for (const line of verbose) {
    // bsdtar mostra links como 'path -> target'; tar GNU com 'l' no modo.
    if (/ -> /.test(line) || /^l[rwx-]/.test(line)) fail('artefato contém link inesperado — extração recusada.');
  }
  for (const entry of entries) {
    const normalized = entry.replace(/\\/g, '/');
    if (normalized.startsWith('/') || normalized.split('/').includes('..')) fail(`entrada insegura no artefato: ${entry}`);
  }
  return entries;
}

function extractArchive(tarBin, archive, staging) {
  const result = spawnSync(tarBin, ['-xzf', archive, '-C', staging], { windowsHide: true });
  if (result.status !== 0) fail('extração falhou.');
  const entries = listTarEntries(tarBin, archive, staging);
  for (const entry of entries) {
    const abs = join(staging, ...entry.split('/'));
    const relStaging = relative(staging, abs);
    if (relStaging.startsWith('..') || relStaging.startsWith(sep)) fail(`extração escapou do staging: ${entry}`);
  }
  return entries;
}

async function prepare() {
  const tarBin = process.env.TAR ?? (process.platform === 'win32' ? 'tar' : 'tar');
  const bytes = await downloadBytes(ASSET_URL);
  const digest = sha256(bytes);
  if (digest !== ASSET_SHA256) fail(`HASH DIVERGE — ${digest} ≠ ${ASSET_SHA256}. Nada foi gravado.`);
  const work = join(tmpdir(), `uptokey-js-debug-${process.pid}-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  const staging = join(dirname(vendorDir), `.js-debug-staging-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const backup = join(dirname(vendorDir), `.js-debug-backup-${process.pid}`);
  const archive = join(work, ASSET);
  try {
    writeFileSync(archive, bytes);
    extractArchive(tarBin, archive, staging);
    const extractedRoot = join(staging, 'js-debug');
    const fileHashes = {};
    for (const rel of EXPECTED_FILES) {
      const src = join(extractedRoot, ...rel.split('/'));
      if (!existsSync(src)) fail(`${rel} ausente no artefato extraído.`);
      fileHashes[rel] = sha256File(src);
    }
    const licensePath = join(extractedRoot, 'LICENSE');
    const licenseText = readFileSync(licensePath, 'utf8');
    if (!licenseText.includes('MIT License') || !licenseText.includes('Copyright')) fail('LICENSE do artefato não confere com MIT.');
    // Transformação local legítima (única diferença para os bytes upstream).
    writeFileSync(join(extractedRoot, 'package.json'), CJS_PACKAGE_JSON);
    // Promoção atômica com rollback.
    if (existsSync(vendorDir)) renameSync(vendorDir, backup);
    try {
      renameSync(extractedRoot, vendorDir);
    } catch (error) {
      if (existsSync(backup) && !existsSync(vendorDir)) renameSync(backup, vendorDir);
      fail(`promoção falhou e a instalação anterior foi restaurada: ${String(error)}`);
    }
    rmSync(backup, { recursive: true, force: true });
    writeFileSync(recordFile, recordPayload(fileHashes));
    console.log(`js-debug preparado: ${TAG} (${LICENSE}) — ${Object.keys(fileHashes).length} arquivos, sha256 do tar ${digest.slice(0, 16)}….`);
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(staging, { recursive: true, force: true });
  }
}

await prepare();
