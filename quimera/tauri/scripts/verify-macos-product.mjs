#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyMacosProductBundle } from './verify-macos-sidecar.mjs';

try {
  if (process.argv.length !== 3) throw Error('macos_product_app_required');
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const result = verifyMacosProductBundle(process.argv[2], repositoryRoot, process.env.UPTOKEY_APPLE_TEAM_ID);
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) {
  process.stderr.write(String(error.message) + '\n');
  process.exitCode = 1;
}