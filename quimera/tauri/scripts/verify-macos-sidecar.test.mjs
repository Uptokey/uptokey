import test from 'node:test';
import assert from 'node:assert/strict';
import { assertMacosSignerDetails, assertSafeMacosEntitlements, assertMacosNodeEntitlements, verifyMacosPreparedSidecar, verifyMacosProductBundle } from './verify-macos-sidecar.mjs';
import { embeddedCoreEntitlementPlist } from '../../../proxy/core/scripts/sign-notarize-macos.mjs';

test('macOS signer evidence requires exact team, identity and hardened runtime', () => {
  const valid='Identifier=com.uptokey.proxy\nTeamIdentifier=TEAM123456\nflags=0x10000(runtime)\n';
  assert.doesNotThrow(()=>assertMacosSignerDetails(valid,'TEAM123456','com.uptokey.proxy'));
  assert.throws(()=>assertMacosSignerDetails(valid,'OTHER12345','com.uptokey.proxy'),/identity_invalid/);
  assert.throws(()=>assertMacosSignerDetails(valid,'TEAM123456','com.other'),/identity_invalid/);
  assert.throws(()=>assertMacosSignerDetails(valid.replace('runtime','adhoc'),'TEAM123456','com.uptokey.proxy'),/identity_invalid/);
  assert.throws(()=>assertMacosSignerDetails('prefix TeamIdentifier=TEAM123456\nIdentifier=com.uptokey.proxy\nflags=runtime','TEAM123456','com.uptokey.proxy'),/identity_invalid/);
});
test('native macOS sidecar admission cannot run on another platform', {skip:process.platform==='darwin'}, () => {
  assert.throws(()=>verifyMacosPreparedSidecar('unused','unused','TEAM123456'),/requires_native_host/);
});
test('macOS admission rejects debug and weakened code-signing entitlements', () => {
  assert.doesNotThrow(()=>assertSafeMacosEntitlements('<plist><dict></dict></plist>'));
  for(const key of ['get-task-allow','com.apple.security.get-task-allow','com.apple.security.cs.disable-library-validation','com.apple.security.cs.allow-unsigned-executable-memory','com.apple.security.cs.disable-executable-page-protection','com.apple.security.cs.allow-dyld-environment-variables']) {
    assert.throws(()=>assertSafeMacosEntitlements('<key>'+key+'</key><true/>'),/forbidden_entitlement/);
  }
});

test('macOS Node admission rejects a signed policy missing JIT or with changed vault identity', () => {
  const policy = embeddedCoreEntitlementPlist('TEAM123456');
  assert.doesNotThrow(() => assertMacosNodeEntitlements(policy, 'TEAM123456'));
  assert.throws(() => assertMacosNodeEntitlements(policy.replace('<key>com.apple.security.cs.allow-jit</key><true/>', ''), 'TEAM123456'), /jit_entitlement_missing/);
  assert.throws(() => assertMacosNodeEntitlements(policy.replace('<true/>', '<false/>'), 'TEAM123456'), /jit_entitlement_missing/);
  assert.throws(() => assertMacosNodeEntitlements(policy.replace('</dict>', '<key>com.apple.security.cs.allow-jit</key><false/></dict>'), 'TEAM123456'), /jit_entitlement_missing/);
  assert.throws(() => assertMacosNodeEntitlements(policy, 'OTHER12345'), /keychain_entitlement_missing/);
  assert.throws(() => assertMacosNodeEntitlements(policy.replace('</dict>', '<key>com.apple.security.cs.disable-library-validation</key><true/></dict>'), 'TEAM123456'), /forbidden_entitlement/);
});
test('macOS final product verification requires a real native host', {skip:process.platform==='darwin'}, () => {
  assert.throws(()=>verifyMacosProductBundle('unused','unused','TEAM123456'),/requires_native_host/);
});
