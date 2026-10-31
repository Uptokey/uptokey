import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

export function parsePreparationArgs(args, { cwd = process.cwd(), tauriDir }) {
  let check = false, directory;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--check') { check = true; continue; }
    if (arg === '--output') {
      if (directory !== undefined || !args[index + 1] || args[index + 1].startsWith('-')) throw Error('sidecar_output_required');
      directory = args[++index];
    } else {
      if (arg.startsWith('-') || directory !== undefined) throw Error('sidecar_argument_invalid');
      directory = arg;
    }
  }
  return { check, directory: directory === undefined ? join(tauriDir, 'resources', 'sidecar') : resolve(cwd, directory) };
}

export function validateOutputTarget(directory, protectedDirectories) {
  const target = resolve(directory);
  if (target === parse(target).root) throw Error('sidecar_output_protected');
  for (const protectedDirectory of protectedDirectories) {
    const rel = relative(target, resolve(protectedDirectory));
    if (rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep))) throw Error('sidecar_output_protected');
  }
  // Never follow a junction/symlink while replacing an output directory.
  for (let current = target; ; current = dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw Error('sidecar_output_link');
    if (current === dirname(current)) break;
  }
  if (existsSync(target)) {
    if (!lstatSync(target).isDirectory()) throw Error('sidecar_output_not_directory');
    let manifest;
    try { manifest = JSON.parse(readFileSync(join(target, 'manifest.json'), 'utf8')); } catch { throw Error('sidecar_output_not_prepared'); }
    const legacy = [1, 2].includes(manifest.schema_version) && ['uptokey', 'uptokey-windows.exe'].includes(manifest.binary_name);
    const macos = manifest.schema_version === 2 && manifest.runtime === 'node' && manifest.target === 'darwin'
      && manifest.binary_name === 'UptokeyCore.app/Contents/MacOS/uptokey';
    if (!legacy && !macos) throw Error('sidecar_output_not_prepared');
  }
  return target;
}

export function createStagingOutput(directory, protectedDirectories) {
  const target = validateOutputTarget(directory, protectedDirectories);
  mkdirSync(dirname(target), { recursive: true });
  return mkdtempSync(join(dirname(target), `.${basename(target)}-staging-`));
}

export function publishStagingOutput(staging, directory, protectedDirectories) {
  const target = validateOutputTarget(directory, protectedDirectories);
  const source = resolve(staging);
  if (dirname(source) !== dirname(target) || !basename(source).startsWith(`.${basename(target)}-staging-`)
    || !lstatSync(source).isDirectory() || lstatSync(source).isSymbolicLink()) throw Error('sidecar_staging_invalid');
  const backup = existsSync(target) ? join(dirname(target), `.${basename(target)}-previous-${randomUUID()}`) : null;
  if (backup) renameSync(target, backup);
  try { renameSync(source, target); }
  catch (error) { if (backup) renameSync(backup, target); throw error; }
  return backup;
}
