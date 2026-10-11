import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { compiledVersionDefineArgs, requiredCompiledVersion, updateOriginDefineArgs, updateTrustDefineArgs } from "./build-update-trust.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE = "uptokey";
const MAINTAINER = "Uptokey <contato@uptokey.com>";
const DEPENDS = "ca-certificates, default-dbus-session-bus | dbus-session-bus, libsecret-1-0";

export function linuxDebLayout(outputRoot = resolve(root, "dist"), version = process.env.UPTOKEY_BUILD_VERSION ?? "") {
  const normalized = requiredCompiledVersion(version);
  return {
    stage: resolve(outputRoot, "linux-deb-stage"),
    executable: resolve(outputRoot, "linux-deb-stage", "usr", "bin", "uptokey"),
    service: resolve(outputRoot, "linux-deb-stage", "usr", "lib", "systemd", "user", "uptokey.service"),
    license: resolve(outputRoot, "linux-deb-stage", "usr", "share", "doc", "uptokey", "copyright"),
    readme: resolve(outputRoot, "linux-deb-stage", "usr", "share", "doc", "uptokey", "README.Debian"),
    control: resolve(outputRoot, "linux-deb-stage", "DEBIAN", "control"),
    postinst: resolve(outputRoot, "linux-deb-stage", "DEBIAN", "postinst"),
    prerm: resolve(outputRoot, "linux-deb-stage", "DEBIAN", "prerm"),
    package: resolve(outputRoot, "uptokey-linux-amd64.deb"),
    version: normalized,
    architecture: "amd64",
  };
}
export function debianControl(version) {
  const normalized = requiredCompiledVersion(version);
  return [
    `Package: ${PACKAGE}`,
    `Version: ${normalized}`,
    "Section: utils",
    "Priority: optional",
    "Architecture: amd64",
    `Maintainer: ${MAINTAINER}`,
    `Depends: ${DEPENDS}`,
    "Recommends: gnome-keyring",
    "Homepage: https://uptokey.com/",
    "Description: local BYOK proxy for multiple AI providers",
    " Uptokey routes OpenAI-compatible requests through provider keys held",
    " in the current user's native desktop secret store.",
    "",
  ].join("\n");
}

export function validateDebianControl(text, expectedVersion, expectedArchitecture = "amd64") {
  const fields = parseControl(text);
  const errors = [];
  if (fields.Package !== PACKAGE) errors.push("deb_package_name_invalid");
  if (fields.Version !== requiredCompiledVersion(expectedVersion)) errors.push("deb_package_version_invalid");
  if (fields.Architecture !== expectedArchitecture || expectedArchitecture !== "amd64") errors.push("deb_package_architecture_invalid");
  if (fields.Maintainer !== MAINTAINER) errors.push("deb_package_maintainer_invalid");
  if (fields.Depends !== DEPENDS || fields.Recommends !== "gnome-keyring") errors.push("deb_package_runtime_dependencies_invalid");
  if (fields.Homepage !== "https://uptokey.com/") errors.push("deb_package_homepage_invalid");
  return errors;
}

export function validateMaintainerScript(text, kind) {
  const expected = kind === "postinst" ? ["configure", "abort-upgrade", "abort-remove", "abort-deconfigure"] : kind === "prerm" ? ["remove", "upgrade", "deconfigure", "failed-upgrade"] : [];
  const errors = [];
  if (!text.startsWith("#!/bin/sh\nset -eu\n") || expected.length === 0 || expected.some((action) => !text.includes(action))) errors.push(`deb_${kind}_contract_invalid`);
  if (/\b(?:curl|wget|apt(?:-get)?|dpkg|systemctl|sudo|su)\b|https?:\/\/|\|\s*(?:sh|bash)\b/.test(text)) errors.push(`deb_${kind}_side_effect_forbidden`);
  return errors;
}

export function buildLinuxDeb(outputRoot) {
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("linux_deb_build_requires_linux_x64");
  const layout = linuxDebLayout(outputRoot ? resolve(outputRoot) : undefined);
  for (const path of [layout.stage, layout.package]) if (existsSync(path)) throw new Error("linux_deb_output_already_exists");
  for (const path of [layout.executable, layout.service, layout.license, layout.readme, layout.control, layout.postinst, layout.prerm]) mkdirSync(dirname(path), { recursive: true });
  run("bun", ["build", "--compile", ...updateTrustDefineArgs(), ...updateOriginDefineArgs(), ...compiledVersionDefineArgs(), "--define", 'UPTOKEY_LINUX_PACKAGE_CHANNEL="deb"', "src/cli.ts", "--outfile", layout.executable], root);
  copyFileSync(resolve(root, "packaging", "linux", "uptokey.service"), layout.service);
  copyFileSync(resolve(root, "LICENSE"), layout.license);
  copyFileSync(resolve(root, "packaging", "linux", "README-DEBIAN.md"), layout.readme);
  copyFileSync(resolve(root, "packaging", "linux", "postinst"), layout.postinst);
  copyFileSync(resolve(root, "packaging", "linux", "prerm"), layout.prerm);
  writeFileSync(layout.control, debianControl(layout.version), { flag: "wx", mode: 0o644 });
  chmodSync(layout.executable, 0o755); chmodSync(layout.postinst, 0o755); chmodSync(layout.prerm, 0o755);
  for (const path of [layout.service, layout.license, layout.readme, layout.control]) chmodSync(path, 0o644);
  assertStage(layout);
  run("dpkg-deb", ["--root-owner-group", "--build", layout.stage, layout.package], root);
  if (!statSync(layout.package).isFile() || statSync(layout.package).size === 0) throw new Error("linux_deb_artifact_invalid");
  const info = run("dpkg-deb", ["--field", layout.package], root);
  const errors = validateDebianControl(info, layout.version, layout.architecture); if (errors.length) throw new Error(errors[0]);
  return layout;
}

function assertStage(layout) {
  for (const path of [layout.executable, layout.service, layout.license, layout.readme, layout.control, layout.postinst, layout.prerm]) {
    const metadata = lstatSync(path); if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0) throw new Error("linux_deb_stage_invalid");
  }
  const postinst = readFileSync(layout.postinst, "utf8"); const prerm = readFileSync(layout.prerm, "utf8");
  const errors = [...validateMaintainerScript(postinst, "postinst"), ...validateMaintainerScript(prerm, "prerm"), ...validateDebianControl(readFileSync(layout.control, "utf8"), layout.version)];
  if (errors.length) throw new Error(errors[0]);
  if (existsSync(resolve(layout.stage, "usr", "lib", "uptokey-update-helper")) || existsSync(resolve(layout.stage, "usr", "lib", "uptokey", "uptokey-linux-secret-portal.node"))) throw new Error("linux_deb_forbidden_payload");
}

function parseControl(text) {
  const fields = {};
  for (const line of text.replaceAll("\r", "").split("\n")) { const match = /^([A-Za-z][A-Za-z0-9-]*): (.+)$/.exec(line); if (match) fields[match[1]] = match[2]; }
  return fields;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024 });
  if (result.status !== 0 || result.error || result.signal) throw new Error(`${command}_failed:${String(result.stderr || result.stdout).replace(/[\r\n]+/g, " ").slice(0, 300)}`);
  return result.stdout;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { const layout = buildLinuxDeb(process.argv[2]); process.stdout.write(`Debian package não assinado criado em ${layout.package}.\n`); }
  catch { process.stderr.write("Build Debian recusado: build_failed\n"); process.exitCode = 1; }
}
