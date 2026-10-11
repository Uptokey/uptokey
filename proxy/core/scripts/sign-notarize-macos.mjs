import { copyFileSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const bundleId = "com.uptokey.proxy";

export function signAndNotarizeMacos({ appPath, identity, notaryProfile, provisioningProfile, teamId, archivePath }) {
  if (process.platform !== "darwin") throw new Error("macos_signing_requires_macos");
  validateValue(identity, /^[^\r\n]{3,160}$/, "signing_identity_invalid");
  validateValue(notaryProfile, /^[A-Za-z0-9._-]{1,80}$/, "notary_profile_invalid");
  validateValue(teamId, /^[A-Z0-9]{10}$/, "apple_team_id_invalid");
  if (typeof provisioningProfile !== "string" || !existsSync(provisioningProfile)) throw new Error("provisioning_profile_missing");
  const app = resolve(appPath);
  const executable = resolve(app, "Contents", "MacOS", "uptokey");
  const nativeModule = resolve(app, "Contents", "Frameworks", "uptokey-macos-protected-keyring.node");
  const updateHelper = resolve(app, "Contents", "Helpers", "uptokey-update-helper");
  if (!existsSync(executable) || !existsSync(nativeModule) || !existsSync(updateHelper)) throw new Error("macos_bundle_incomplete");
  const archive = resolve(archivePath ?? `${app}.zip`);
  if (existsSync(archive)) throw new Error("macos_archive_already_exists");
  const signingIdentity = assertIdentityAvailable(identity, teamId);

  const temporary = mkdtempSync(resolve(tmpdir(), "uptokey-sign-"));
  try {
    const profile = realpathSync(provisioningProfile);
    const decodedProfile = resolve(temporary, "profile.plist");
    run("security", ["cms", "-D", "-i", profile, "-o", decodedProfile]);
    const profileEntitlements = parseObject(run("plutil", ["-extract", "Entitlements", "json", "-o", "-", decodedProfile]));
    validateProvisioningProfileClaims({
      teamIds: parseStringArray(run("plutil", ["-extract", "TeamIdentifier", "json", "-o", "-", decodedProfile])),
      applicationIdentifier: profileEntitlements["application-identifier"],
      keychainAccessGroups: profileEntitlements["keychain-access-groups"],
      getTaskAllow: profileEntitlements["get-task-allow"],
      expirationDate: run("plutil", ["-extract", "ExpirationDate", "raw", decodedProfile]).trim()
    }, teamId);
    copyFileSync(profile, resolve(app, "Contents", "embedded.provisionprofile"), 0);
    const entitlements = resolve(temporary, "Uptokey.entitlements.plist");
    writeFileSync(entitlements, entitlementPlist(teamId), { flag: "wx", mode: 0o600 });
    sign(nativeModule, signingIdentity);
    sign(updateHelper, signingIdentity);
    sign(executable, signingIdentity, entitlements);
    sign(app, signingIdentity, entitlements);
    run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);

    const submission = resolve(temporary, "submission.zip");
    run("ditto", ["-c", "-k", "--keepParent", app, submission]);
    run("xcrun", ["notarytool", "submit", submission, "--keychain-profile", notaryProfile, "--wait"]);
    run("xcrun", ["stapler", "staple", app]);
    run("xcrun", ["stapler", "validate", app]);
    run("spctl", ["--assess", "--type", "execute", "--verbose=2", app]);
    run("ditto", ["-c", "-k", "--keepParent", app, archive]);
    return { app, archive };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function validateProvisioningProfileClaims(claims, teamId, now = Date.now()) {
  const application = `${teamId}.${bundleId}`;
  if (!Array.isArray(claims?.teamIds) || claims.teamIds.length !== 1 || claims.teamIds[0] !== teamId || claims.applicationIdentifier !== application) {
    throw new Error("provisioning_profile_identity_mismatch");
  }
  if (!Array.isArray(claims.keychainAccessGroups) || claims.keychainAccessGroups.length !== 1 || claims.keychainAccessGroups[0] !== application) {
    throw new Error("provisioning_profile_keychain_group_mismatch");
  }
  if (claims.getTaskAllow !== undefined && claims.getTaskAllow !== false) throw new Error("provisioning_profile_debug_forbidden");
  const expiry = Date.parse(claims.expirationDate);
  if (!Number.isFinite(expiry) || expiry <= now) throw new Error("provisioning_profile_expired");
}

function assertIdentityAvailable(identity, teamId) {
  const listed = run("security", ["find-identity", "-v", "-p", "codesigning"]);
  const fingerprint = selectSigningIdentityFingerprint(listed, identity);
  const certificate = runCombined("security", ["find-certificate", "-c", identity, "-p"]);
  if (!certificate.includes("BEGIN CERTIFICATE")) throw new Error("signing_certificate_not_available");
  const observedFingerprint = runWithInput("openssl", ["x509", "-noout", "-fingerprint", "-sha1"], certificate);
  assertCertificateFingerprint(observedFingerprint, fingerprint);
  const subject = runWithInput("openssl", ["x509", "-noout", "-subject", "-nameopt", "RFC2253"], certificate);
  assertCertificateTeam(subject, teamId);
  return fingerprint;
}

export function selectSigningIdentityFingerprint(listed, identity) {
  const matches = [...listed.matchAll(/^\s*\d+\)\s+([A-F0-9]{40})\s+"([^"\r\n]+)"\s*$/gmi)]
    .filter((match) => match[2] === identity)
    .map((match) => match[1].toUpperCase());
  if (matches.length === 0) throw new Error("signing_identity_not_available");
  if (matches.length !== 1) throw new Error("signing_identity_ambiguous");
  return matches[0];
}

export function assertCertificateFingerprint(output, expected) {
  const observed = /(?:SHA1 Fingerprint|sha1 Fingerprint)=([A-F0-9:]{40,59})/i.exec(output)?.[1]?.replaceAll(":", "").toUpperCase();
  if (observed !== expected.toUpperCase()) throw new Error("signing_certificate_fingerprint_mismatch");
}

export function assertCertificateTeam(subject, teamId) {
  const organizationUnit = /(?:^|,)OU=([A-Z0-9]{10})(?:,|$)/.exec(subject.replace(/^subject=\s*/, ""))?.[1];
  if (organizationUnit !== teamId) throw new Error("signing_identity_team_mismatch");
}

function sign(target, identity, entitlements) {
  const args = ["--force", "--sign", identity, "--options", "runtime", "--timestamp"];
  if (entitlements) args.push("--entitlements", entitlements);
  args.push(target);
  run("codesign", args);
}

function entitlementPlist(teamId) {
  const application = `${teamId}.${bundleId}`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>application-identifier</key><string>${application}</string>\n<key>keychain-access-groups</key><array><string>${application}</string></array>\n</dict></plist>\n`;
}

function parseStringArray(value) {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) throw new Error();
    return parsed;
  } catch { throw new Error("provisioning_profile_array_invalid"); }
}

function parseObject(value) {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch { throw new Error("provisioning_profile_entitlements_invalid"); }
}

function validateValue(value, pattern, error) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(error);
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`${basename(command)}_failed:${clean(result.stderr || result.stdout)}`);
  return result.stdout;
}

function runCombined(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`${basename(command)}_failed:${clean(result.stderr || result.stdout)}`);
  return `${result.stdout}\n${result.stderr}`;
}

function runWithInput(command, args, input) {
  const result = spawnSync(command, args, { input, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`${basename(command)}_failed:${clean(result.stderr || result.stdout)}`);
  return result.stdout;
}

function clean(value) { return String(value).replace(/[\r\n]+/g, " ").slice(0, 300); }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = signAndNotarizeMacos({ appPath: process.argv[2], identity: process.env.UPTOKEY_APPLE_SIGNING_IDENTITY, notaryProfile: process.env.UPTOKEY_APPLE_NOTARY_PROFILE, provisioningProfile: process.env.UPTOKEY_APPLE_PROVISIONING_PROFILE, teamId: process.env.UPTOKEY_APPLE_TEAM_ID, archivePath: process.argv[3] });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write("Assinatura macOS recusada: signing_failed\n");
    process.exitCode = 1;
  }
}
