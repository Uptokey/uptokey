#!/usr/bin/env node
/**
 * B9 — canonical contract surface check (read-only).
 * For every top-level `*.js` in proxy/contratos:
 *   1. a sibling `*.d.ts` exists;
 *   2. every runtime export of the `.js` is declared in the `.d.ts`;
 *   3. every value declaration (const/function/class/enum) in the `.d.ts` exists in the `.js`;
 *   4. package.json `exports` has `./<name>` with `types` → `./<name>.d.ts` and `import` → `./<name>.js`.
 * Also reports `exports` entries that point at missing files. Exit 1 on any mismatch.
 * Usage: node scripts/check-contract-surface.mjs [--json] [contract-root]
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const json = args.includes('--json');
const root = resolve(args.find((a) => !a.startsWith('--')) ?? join(dirname(fileURLToPath(import.meta.url)), '..'));

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

function listNames(block) {
  return block.split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
    const cleaned = part.replace(/^type\s+/, '');
    const as = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(cleaned);
    return as ? as[1] : cleaned.split(/\s+/)[0];
  });
}

export function jsExports(source) {
  const src = stripComments(source);
  const names = new Set();
  for (const m of src.matchAll(/^\s*export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^\s*export\s+(?:const|let|var)\s+\{([^}]*)\}/gm)) for (const n of listNames(m[1])) names.add(n.split(':').pop().trim());
  for (const m of src.matchAll(/^\s*export\s*\{([^}]*)\}(?:\s*from\s*['"][^'"]+['"])?/gm)) for (const n of listNames(m[1])) names.add(n);
  if (/^\s*export\s+default\b/m.test(src)) names.add('default');
  return names;
}

export function dtsExports(source) {
  const src = stripComments(source);
  const values = new Set(); const types = new Set();
  for (const m of src.matchAll(/^\s*export\s+(?:declare\s+)?(?:async\s+)?(function|class|const|let|var|enum|abstract\s+class)\s+([A-Za-z_$][\w$]*)/gm)) values.add(m[2]);
  for (const m of src.matchAll(/^\s*export\s+(?:declare\s+)?(type|interface)\s+([A-Za-z_$][\w$]*)/gm)) types.add(m[2]);
  for (const m of src.matchAll(/^\s*export\s+(type\s+)?\{([^}]*)\}(?:\s*from\s*['"][^'"]+['"])?/gm)) for (const n of listNames(m[2])) (m[1] ? types : values).add(n);
  if (/^\s*export\s+default\b/m.test(src)) values.add('default');
  return { values, types };
}

export function checkContractSurface(dir) {
  const problems = [];
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const exportsMap = pkg.exports ?? {};
  const modules = readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3)).sort();
  for (const name of modules) {
    const dts = join(dir, `${name}.d.ts`);
    if (!existsSync(dts)) { problems.push({ module: name, kind: 'dts_missing' }); continue; }
    const js = jsExports(readFileSync(join(dir, `${name}.js`), 'utf8'));
    const d = dtsExports(readFileSync(dts, 'utf8'));
    for (const n of js) if (!d.values.has(n)) problems.push({ module: name, kind: d.types.has(n) ? 'js_value_declared_only_as_type' : 'js_export_undeclared', name: n });
    for (const n of d.values) if (!js.has(n)) problems.push({ module: name, kind: 'dts_value_without_runtime', name: n });
    const entry = exportsMap[`./${name}`];
    if (!entry) problems.push({ module: name, kind: 'package_export_missing' });
    else if (typeof entry !== 'object' || entry.types !== `./${name}.d.ts` || entry.import !== `./${name}.js` || (entry.default !== undefined && entry.default !== `./${name}.js`)) problems.push({ module: name, kind: 'package_export_mismatch', entry });
  }
  for (const [key, entry] of Object.entries(exportsMap)) {
    const targets = typeof entry === 'string' ? [entry] : Object.values(entry ?? {}).filter((v) => typeof v === 'string');
    for (const target of targets) if (!existsSync(join(dir, target))) problems.push({ module: key, kind: 'package_export_target_missing', target });
  }
  const warnings = [];
  const referenced = new Set(Object.values(exportsMap).flatMap((entry) => typeof entry === 'string' ? [entry] : Object.values(entry ?? {})));
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.d.ts'))) {
    if (existsSync(join(dir, f.replace(/\.d\.ts$/, '.js')))) continue;
    // Types-only declaration: valid TypeScript, but unreachable through package exports unless mapped.
    warnings.push({ module: f, kind: referenced.has(`./${f}`) ? 'types_only_module' : 'types_only_module_unexported' });
  }
  return { root: dir, modules: modules.length, problems, warnings };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkContractSurface(root);
  if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    process.stdout.write(`contract surface: ${result.modules} modules, ${result.problems.length} problem(s) in ${result.root}\n`);
    for (const p of result.problems) process.stdout.write(`  ${p.module}: ${p.kind}${p.name ? ` ${p.name}` : ''}${p.target ? ` ${p.target}` : ''}${p.entry ? ` ${JSON.stringify(p.entry)}` : ''}\n`);
    for (const w of result.warnings) process.stdout.write(`  warning ${w.module}: ${w.kind}\n`);
  }
  process.exitCode = result.problems.length ? 1 : 0;
}
