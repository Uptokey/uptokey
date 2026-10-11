import { createHash } from 'node:crypto';
import { artifactCodeBlocks, type VerificationCheck } from './artifact-verification.ts';
import { ProjectRuntimeError, type OciResult } from './project-oci.ts';
import { parseProjectRunRequest, parseProjectVerificationReport, type ProjectCheckResult } from '@uptokey/sync-contract/project-agent';
import type { Artifact } from '@uptokey/sync-contract/workflow';
import type { WorkspaceStore, WorkspaceBundle } from './store.ts';

export const ARTIFACT_CODE_ACTIONS = ['artifact_typecheck', 'artifact_test'] as const;
export type ArtifactCodeAction = typeof ARTIFACT_CODE_ACTIONS[number];
export const isArtifactCodeAction = (action: string): action is ArtifactCodeAction => ARTIFACT_CODE_ACTIONS.some(value => value === action);
export interface ArtifactCodeSnapshot { id: string; sha256: string; byteLength: number; mediaType: string }
export interface ArtifactCodeInput extends ArtifactCodeSnapshot { bytes: Uint8Array }
export function artifactCodeSnapshot(artifact: ArtifactCodeSnapshot): ArtifactCodeSnapshot {
  if (artifact.mediaType !== 'text/markdown' || artifact.byteLength > 1_048_576 || artifact.byteLength < 1 || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
    throw new ProjectRuntimeError('runtime_artifact_format_unsupported');
  }
  return { id: artifact.id, sha256: artifact.sha256, byteLength: artifact.byteLength, mediaType: artifact.mediaType };
}
export function artifactCodeFiles(artifact: ArtifactCodeInput, directory: string) {
  artifactCodeSnapshot(artifact);
  if (artifact.bytes.byteLength !== artifact.byteLength || createHash('sha256').update(artifact.bytes).digest('hex') !== artifact.sha256) {
    throw new ProjectRuntimeError('runtime_artifact_hash_conflict');
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(artifact.bytes);
  const prefix = directory && directory !== '.' ? `${directory}/` : '';
  const extensions: Record<string, string> = { js: 'mjs', javascript: 'mjs', mjs: 'mjs', cjs: 'cjs', ts: 'mts', typescript: 'mts', mts: 'mts', cts: 'cts' };
  return artifactCodeBlocks(text).map((block, index) => ({
    path: `${prefix}uptokey-artifact-${artifact.sha256}-${index + 1}.${extensions[block.lang]}`,
    bytes: Buffer.from(block.code),
  }));
}

/** Fixed supervisor runs only inside the existing OCI backend. Never evaluated by the host. */
export const ARTIFACT_CODE_SUPERVISOR = String.raw`
const action = process.argv[2], files = JSON.parse(process.argv[3]);
const emit = value => process.stdout.write(JSON.stringify({schema:'uptokey-artifact-code-v1',...value})+'\n');
(async()=>{
 if(action==='artifact_typecheck'){
  const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
  const compiler='/usr/local/lib/node_modules/typescript/bin/tsc';
  if(!fs.existsSync(compiler)){emit({status:'blocked',code:'runtime_typechecker_unavailable'});return;}
  const base=path.join(process.cwd(),'tsconfig.json'),temporary=fs.mkdtempSync(path.join(os.tmpdir(),'uptokey-typecheck-')),config=path.join(temporary,'tsconfig.json');
  const configuration={...(fs.existsSync(base)?{extends:base}:{}),compilerOptions:{noEmit:true,incremental:false,composite:false,allowJs:true,checkJs:true,strict:true},files};
  fs.writeFileSync(config,JSON.stringify(configuration));
  const execute=args=>spawnSync(process.execPath,[compiler,...args],{encoding:'utf8',timeout:20000,maxBuffer:131072,env:{...process.env,GOMAXPROCS:'1'},windowsHide:true});
  const versionProbe=execute(['--version']);
  if(versionProbe.error||versionProbe.status!==0||!/^Version \d+(?:\.\d+)+/m.test(versionProbe.stdout)){emit({status:'blocked',code:'runtime_typechecker_unavailable'});return;}
  let result=execute(['--showConfig','--project',config,'--pretty','false']);
  if(result.error){emit({status:'blocked',code:'runtime_verification_tool_failed'});process.exitCode=2;return;}
  if(result.status===0){
   const expanded=JSON.parse(result.stdout);
   configuration.compilerOptions.typeRoots=[...(expanded.compilerOptions?.typeRoots||[]).map(root=>path.resolve(temporary,root)),'/usr/local/lib/node_modules/@types'];
   configuration.exclude=[...(expanded.exclude||[]).map(entry=>path.resolve(temporary,entry)),__filename];
   fs.writeFileSync(config,JSON.stringify(configuration));result=execute(['--project',config,'--pretty','false']);
  }
  if(result.error||result.status===null){emit({status:'blocked',code:'runtime_verification_tool_failed'});process.exitCode=2;return;}
  const diagnostics=[...(result.stdout+'\n'+result.stderr).matchAll(/error TS(\d+):/g)].map(match=>Number(match[1]));
  const status=result.status===0?'pass':'fail',version=JSON.parse(fs.readFileSync(path.join(path.dirname(compiler),'../package.json'),'utf8')).version;
  emit({status,tool:'typescript',version,diagnostics:diagnostics.length,codes:[...new Set(diagnostics)].slice(0,64),files:files.length});process.exitCode=status==='pass'?0:1;return;
 }
 if(action!=='artifact_test')throw Error('runtime_action_unavailable');
 const {run}=require('node:test');let passed=0,failed=0,skipped=0,discovered=0,summary;
 const tests=run({files,concurrency:1,isolation:'process',execArgv:[]});
 for await(const event of tests){
  const d=event.data;
  if(event.type==='test:summary'&&!d.file)summary=d;
  if(event.type==='test:fail')failed++;
  if((event.type==='test:pass'||event.type==='test:fail')&&d.details?.type!=='suite'&&d.name!==d.file){
   discovered++;if(d.skip||d.todo)skipped++;else if(event.type==='test:pass')passed++;
  }
 }
 const status=!summary||summary.success!==true||failed?'fail':passed===0?'blocked':'pass';
 emit({status,code:status==='blocked'?'runtime_no_executed_tests':!summary?'runtime_test_summary_missing':undefined,tool:'node:test',version:process.version,testsDiscovered:discovered,testsPassed:passed,testsFailed:failed,testsSkipped:skipped});
 process.exitCode=status==='fail'?1:0;
})().catch(()=>{emit({status:'blocked',code:'runtime_verification_tool_failed'});process.exitCode=2;});
`;

/** Container stdout is data: retain only bounded numeric diagnostics, never code or raw output. */
export function artifactCodeResult(action: ArtifactCodeAction, artifact: ArtifactCodeSnapshot, result: OciResult): ProjectCheckResult {
  let value: Record<string, unknown> = {};
  try { const parsed=JSON.parse(result.stdout.toString('utf8'));if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))value=parsed; } catch { /* Missing/invalid output cannot pass. */ }
  const numeric = (key: string) => typeof value[key] === 'number' && Number.isSafeInteger(value[key]) && Number(value[key]) >= 0 ? Number(value[key]) : undefined;
  const valid = value?.schema === 'uptokey-artifact-code-v1' && ['pass', 'fail', 'blocked'].includes(String(value.status));
  let status: ProjectCheckResult['status'] = valid && value.status === 'blocked' ? 'blocked' : valid && value.status === 'pass' && result.exitCode === 0 && !result.limited ? 'pass' : 'fail';
  if (action === 'artifact_test' && status === 'pass' && !(Number(numeric('testsPassed')) > 0)) status = 'blocked';
  if (action === 'artifact_test' && status === 'pass' && (numeric('testsFailed') !== 0 || numeric('testsDiscovered') === undefined || numeric('testsSkipped') === undefined)) status = 'fail';
  if (action === 'artifact_typecheck' && status === 'pass' && (numeric('diagnostics') !== 0 || !(Number(numeric('files')) > 0))) status = 'fail';
  const allowedCodes = ['runtime_typechecker_unavailable', 'runtime_no_executed_tests', 'runtime_test_summary_missing', 'runtime_verification_tool_failed'];
  const observed = { artifactId: artifact.id, sha256: artifact.sha256, action, outputLimited: result.limited,
    code: result.limited ? 'runtime_output_limit' : !valid ? 'runtime_verification_output_invalid' : allowedCodes.includes(String(value.code)) ? value.code : undefined,
    tool: action === 'artifact_test' ? 'node:test' : 'typescript',
    version: typeof value.version === 'string' && /^v?\d+(?:\.\d+){1,3}(?:[-a-z0-9.]+)?$/i.test(value.version) ? value.version : undefined,
    ...(action === 'artifact_test' ? { testsDiscovered: numeric('testsDiscovered'), testsPassed: numeric('testsPassed'), testsFailed: numeric('testsFailed'), testsSkipped: numeric('testsSkipped') }
      : { diagnostics: numeric('diagnostics'), files: numeric('files'), codes: Array.isArray(value.codes) ? value.codes.filter(code => Number.isSafeInteger(code) && code >= 0).slice(0,64) : [] }),
  };
  return { id: action, method: 'isolated_artifact_code_v1', exitCode: Math.max(0, Math.min(255, result.exitCode)),
    expected: action === 'artifact_test' ? 'Explicit Node tests executed, exit 0 and bounded complete summary' : 'TypeScript compiler: strict/noEmit/checkJs, approved project configuration and artifact blocks',
    observed: JSON.stringify(observed), artifactRefs: [artifact.id], status };
}

/** Read-only projection. Only a succeeded W5 receipt/plan can supply execution evidence. */
export async function recordedArtifactCodeChecks(store: WorkspaceStore, bundle: WorkspaceBundle, principal: string, artifact: Artifact, signal?: AbortSignal): Promise<VerificationCheck[]> {
  const checks: VerificationCheck[] = [], found = new Set<string>();
  for (const record of [...bundle.runs].reverse()) {
    signal?.throwIfAborted();
    if (record.run.principalId !== principal) continue;
    const plan = bundle.plans.find(item => item.id === record.run.planId && item.digest === record.run.planDigest);
    const step = plan?.steps.find(item => item.capabilityId === 'workspace.project.run');
    if (!step || step.arguments.request?.kind !== 'literal' || step.arguments.artifact_snapshot?.kind !== 'literal') continue;
    let request;try { request = parseProjectRunRequest(step.arguments.request.value); } catch { continue; }
    if (!isArtifactCodeAction(request.actionId) || found.has(request.actionId) || request.artifactInputRefs.length !== 1 || request.artifactInputRefs[0] !== artifact.id) continue;
    const sealed = step.arguments.artifact_snapshot.value as unknown as ArtifactCodeSnapshot;
    if (sealed?.id !== artifact.id || sealed.sha256 !== artifact.sha256 || sealed.byteLength !== artifact.byteLength || sealed.mediaType !== artifact.mediaType) continue;
    found.add(request.actionId);
    const rule = `execution.${request.actionId}`;
    const receipt = record.receipts.find(item => item.stepId === step.id && item.capabilityId === 'workspace.project.run' && item.status === 'succeeded');
    const output = receipt && bundle.artifacts.find(item => item.runId === record.run.id && item.mediaType === 'application/json' && receipt.outputArtifactRefs.includes(item.id));
    if (!output || record.run.status !== 'succeeded') { checks.push({rule,version:1,result:'not_applicable',detail:`run=${record.run.id}; ${record.run.status}; no completed verification receipt`}); continue; }
    try {
      const report = parseProjectVerificationReport(JSON.parse(await store.readTextArtifact(principal, bundle.project.id, output.id)));
      signal?.throwIfAborted();
      const check = report.checks.find(item => item.id === request.actionId && item.method === 'isolated_artifact_code_v1' && item.artifactRefs.includes(artifact.id));
      const observed = check && JSON.parse(check.observed);
      if (!check || report.runId !== record.run.id || report.manifestDigest !== request.manifestDigest || observed.artifactId !== artifact.id || observed.sha256 !== artifact.sha256) throw Error('runtime_verification_evidence_invalid');
      checks.push({rule,version:1,result:check.status==='pass'?'passed':check.status==='fail'?'failed':'not_applicable',detail:`run=${report.runId}; manifest=${report.manifestDigest}; runtime=${report.runtimeFingerprint}; ${check.observed}`});
    } catch (error) { if(signal?.aborted)throw error;checks.push({rule,version:1,result:'not_applicable',detail:'runtime_verification_evidence_unavailable'}); }
  }
  return checks;
}
