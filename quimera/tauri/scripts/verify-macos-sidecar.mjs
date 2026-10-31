import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { verifySidecar, sha256File } from './verify-sidecar.mjs';
import { verifyHarnessPayload } from './frontend-hook.mjs';
import { admitAcceptedNodeRuntimeLicense } from './accepted-sidecar-artifacts.mjs';
import { assertMacosKeychainEntitlements } from '../../../proxy/core/scripts/native-signature-evidence.mjs';

function run(command, args, combined = false) {
  const result = spawnSync(command, args, { encoding:'utf8', windowsHide:true, timeout:30000, maxBuffer:1024*1024 });
  if (result.error || result.status !== 0) throw Error('macos_sidecar_signature_invalid');
  return combined ? (result.stdout + '\n' + result.stderr) : result.stdout;
}
export function assertMacosSignerDetails(details, teamId, identifier) {
  if (!/^[A-Z0-9]{10}$/.test(teamId) || !details.split(/\r?\n/).includes('TeamIdentifier='+teamId)
      || !details.split(/\r?\n/).includes('Identifier='+identifier)
      || !/flags=.*runtime/i.test(details)) throw Error('macos_sidecar_identity_invalid');
}

export function assertSafeMacosEntitlements(entitlements) {
  if (/allow-unsigned-executable-memory|disable-library-validation|disable-executable-page-protection|allow-dyld-environment-variables|get-task-allow/.test(entitlements)) {
    throw Error('macos_sidecar_forbidden_entitlement');
  }
}
export function assertMacosNodeEntitlements(entitlements, teamId) {
  assertSafeMacosEntitlements(entitlements);
  assertMacosKeychainEntitlements(entitlements, teamId);
  if ((entitlements.match(/<key>com\.apple\.security\.cs\.allow-jit<\/key>/g) ?? []).length !== 1
      || !/<key>com\.apple\.security\.cs\.allow-jit<\/key>\s*<true\s*\/>/.test(entitlements)) {
    throw Error('macos_node_jit_entitlement_missing');
  }
}
/** Native verification only; this does not establish notarization or installed bootstrap. */
export function verifyMacosPreparedSidecar(directory, repositoryRoot, teamId, { harness = false } = {}) {
  if (process.platform !== 'darwin' || !['x64','arm64'].includes(process.arch)) throw Error('macos_sidecar_requires_native_host');
  if (!/^[A-Z0-9]{10}$/.test(teamId ?? '')) throw Error('macos_sidecar_team_missing');
  const root = resolve(directory), manifestPath = join(root,'manifest.json');
  const before = sha256File(manifestPath);
  if (harness) verifyHarnessPayload(root); else verifySidecar(root,'darwin',process.arch);
  const manifest = JSON.parse(readFileSync(manifestPath,'utf8'));
  const binary = 'UptokeyCore.app/Contents/MacOS/uptokey';
  if (manifest.binary_name !== binary || manifest.build_version !== '0.1.0-beta.22'
      || (harness ? manifest.harness?.schema_version !== 1 : manifest.harness !== undefined)) throw Error('macos_sidecar_manifest_invalid');
  const original = join(repositoryRoot,'experiments/deepseek-workbench/output/node-macos-provenance-20261027','node-'+process.arch);
  const node = admitAcceptedNodeRuntimeLicense(repositoryRoot, original);
  if (manifest.runtimeLicense?.sourceNodeSha256 !== node.nodeSha256
      || manifest.runtimeLicense?.nodeSha256 !== manifest.files[binary]?.sha256
      || manifest.runtimeLicense?.sha256 !== node.licenseSha256
      || manifest.files?.['NODE-LICENSE.txt']?.sha256 !== node.licenseSha256
      || manifest.runtimeLicense?.signatureVerified !== node.signatureVerified
      || JSON.stringify(manifest.runtimeLicense?.signatureReceipt) !== JSON.stringify(node.signatureReceipt)) throw Error('macos_sidecar_provenance_invalid');
  const app = join(root,'UptokeyCore.app'), helper = join(root,'uptokey-computer-mcp'), nodeExecutable = join(root,binary);
  run('codesign',['--verify','--deep','--strict','--verbose=2',app]);
  run('codesign',['--verify','--strict','--verbose=2',nodeExecutable]);
  run('codesign',['--verify','--strict','--verbose=2',helper]);
  assertMacosSignerDetails(run('codesign',['-d','--verbose=4',app],true),teamId,'com.uptokey.proxy');
  assertMacosSignerDetails(run('codesign',['-d','--verbose=4',nodeExecutable],true),teamId,'com.uptokey.proxy');
  const helperDetails=run('codesign',['-d','--verbose=4',helper],true);
  if (!helperDetails.split(/\r?\n/).includes('TeamIdentifier='+teamId) || !/flags=.*runtime/i.test(helperDetails)) throw Error('macos_sidecar_identity_invalid');
  const appEntitlements=run('codesign',['-d','--entitlements',':-',app],true);
  const helperEntitlements=run('codesign',['-d','--entitlements',':-',helper],true);
  assertMacosNodeEntitlements(appEntitlements,teamId);
  assertMacosNodeEntitlements(run('codesign',['-d','--entitlements',':-',nodeExecutable],true),teamId);
  assertSafeMacosEntitlements(helperEntitlements);
  if (sha256File(manifestPath) !== before) throw Error('macos_sidecar_changed');
  return { manifestSha256:before, teamId, notarized:false, installed:false };
}
/** Verify the final signed and notarized Tauri app, including its sidecar bytes. */
export function verifyMacosProductBundle(appPath, repositoryRoot, teamId) {
  if (process.platform !== 'darwin') throw Error('macos_sidecar_requires_native_host');
  const app=resolve(appPath), stat=lstatSync(app);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(app)!==app) throw Error('macos_product_bundle_invalid');
  run('codesign',['--verify','--deep','--strict','--verbose=2',app]);
  assertMacosSignerDetails(run('codesign',['-d','--verbose=4',app],true),teamId,'com.uptokey.tauri');
  assertSafeMacosEntitlements(run('codesign',['-d','--entitlements',':-',app],true));
  run('xcrun',['stapler','validate',app]);
  run('spctl',['--assess','--type','execute','--verbose=2',app]);
  const sidecar=verifyMacosPreparedSidecar(join(app,'Contents','Resources','resources','sidecar'),repositoryRoot,teamId,{harness:true});
  return {manifestSha256:sidecar.manifestSha256,teamId,notarized:true,installed:false};
}
