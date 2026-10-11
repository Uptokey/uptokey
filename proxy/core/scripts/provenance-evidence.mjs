import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const schema = "uptokey-provenance-evidence-v1";

export function createProvenanceReceipt(artifact, bundle, repository, signerWorkflow, sourceCommit, run = runGh) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "")) throw new Error("provenance_repository_invalid");
  if (!new RegExp(`^${escapeRegex(repository)}\\/.github\\/workflows\\/[A-Za-z0-9_.-]+\\.yml$`).test(signerWorkflow ?? "")) throw new Error("provenance_signer_workflow_invalid");
  if (!/^[a-f0-9]{40}$/.test(sourceCommit ?? "")) throw new Error("provenance_source_commit_invalid");
  const output = run(["attestation", "verify", artifact, "--repo", repository, "--bundle", bundle, "--signer-workflow", signerWorkflow, "--source-digest", sourceCommit, "--format", "json"]);
  const parsed = provenanceFromGhVerification(output, repository);
  if (parsed.sourceCommit !== sourceCommit) throw new Error("provenance_predicate_source_commit_mismatch");
  const { subjects, transparencyLog } = parsed;
  return {
    schema, verifiedAt: new Date().toISOString(), repository, signerWorkflow, toolchain: ["gh attestation verify"],
    sourceCommit, subjects, transparencyLog, checks: { sigstoreBundle: true, githubOidcIdentity: true, inTotoSubjects: true, slsaBuildDefinition: true, transparencyLog: true },
  };
}

export function provenanceFromGhVerification(output, repository) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "")) throw new Error("provenance_repository_invalid");
  let value;
  try { value = JSON.parse(output); } catch { throw new Error("provenance_verifier_json_invalid"); }
  if (!Array.isArray(value) || value.length === 0) throw new Error("provenance_verification_empty");
  const subjects = [];
  const commits = new Set();
  const transparencyLog = [];
  for (const result of value) {
    const statement = result?.verificationResult?.statement;
    if (statement?._type !== "https://in-toto.io/Statement/v1" || !Array.isArray(statement.subject)) throw new Error("provenance_statement_invalid");
    if (statement.predicateType !== "https://slsa.dev/provenance/v1") throw new Error("provenance_predicate_type_invalid");
    const definition = statement?.predicate?.buildDefinition;
    if (definition?.buildType !== "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1") throw new Error("provenance_build_type_invalid");
    if (definition?.externalParameters?.workflow?.repository !== `https://github.com/${repository}`) throw new Error("provenance_workflow_repository_mismatch");
    const dependency = Array.isArray(definition?.resolvedDependencies)
      ? definition.resolvedDependencies.find((item) => item?.uri?.startsWith(`git+https://github.com/${repository}@`) && /^[a-f0-9]{40}$/.test(item?.digest?.gitCommit ?? ""))
      : undefined;
    if (!dependency) throw new Error("provenance_source_commit_missing");
    commits.add(dependency.digest.gitCommit);
    const witness = Array.isArray(result?.verificationResult?.verifiedTimestamps)
      ? result.verificationResult.verifiedTimestamps.find((item) => item?.type === "Tlog" && typeof item?.timestamp === "string" && Number.isFinite(Date.parse(item.timestamp)))
      : undefined;
    if (!witness) throw new Error("provenance_transparency_log_missing");
    transparencyLog.push({ type: "Tlog", timestamp: witness.timestamp });
    for (const subject of statement.subject) {
      const sha256 = subject?.digest?.sha256;
      if (typeof subject?.name !== "string" || subject.name.length === 0 || !/^[a-f0-9]{64}$/.test(sha256 ?? "")) throw new Error("provenance_subject_invalid");
      subjects.push({ name: subject.name, sha256 });
    }
  }
  if (subjects.length === 0) throw new Error("provenance_subjects_empty");
  if (commits.size !== 1) throw new Error("provenance_source_commit_ambiguous");
  return { subjects: subjects.sort((a, b) => a.sha256.localeCompare(b.sha256) || a.name.localeCompare(b.name)), sourceCommit: [...commits][0], transparencyLog };
}

export function validateProvenanceReceipt(receipt, expectedDigests, expectedCommit, expectedRepository, expectedSignerWorkflow) {
  const errors = [];
  if (!receiptSchema(receipt)) errors.push("provenance_receipt_schema_invalid");
  if (!/^\d{4}-\d{2}-\d{2}T/.test(receipt?.verifiedAt ?? "") || !Number.isFinite(Date.parse(receipt?.verifiedAt))) errors.push("provenance_receipt_timestamp_invalid");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(receipt?.repository ?? "")) errors.push("provenance_receipt_repository_invalid");
  if (receipt?.repository !== expectedRepository) errors.push("provenance_receipt_repository_mismatch");
  if (receipt?.signerWorkflow !== expectedSignerWorkflow) errors.push("provenance_receipt_signer_workflow_mismatch");
  if (receipt?.sourceCommit !== expectedCommit || !/^[a-f0-9]{40}$/.test(receipt?.sourceCommit ?? "")) errors.push("provenance_receipt_source_commit_mismatch");
  if (JSON.stringify(receipt?.toolchain) !== JSON.stringify(["gh attestation verify"])) errors.push("provenance_receipt_toolchain_invalid");
  if (receipt?.checks?.sigstoreBundle !== true || receipt?.checks?.githubOidcIdentity !== true || receipt?.checks?.inTotoSubjects !== true || receipt?.checks?.slsaBuildDefinition !== true || receipt?.checks?.transparencyLog !== true) errors.push("provenance_receipt_check_failed");
  if (!Array.isArray(receipt?.transparencyLog) || receipt.transparencyLog.length === 0 || receipt.transparencyLog.some((item) => item?.type !== "Tlog" || typeof item?.timestamp !== "string" || !Number.isFinite(Date.parse(item.timestamp)))) errors.push("provenance_receipt_transparency_log_invalid");
  const observed = Array.isArray(receipt?.subjects) ? receipt.subjects.map((subject) => subject?.sha256).sort() : [];
  if (observed.some((digest) => !/^[a-f0-9]{64}$/.test(digest ?? "")) || new Set(observed).size !== observed.length || receipt?.subjects?.some((subject) => !safeSubjectName(subject?.name))) errors.push("provenance_receipt_subject_invalid");
  if (JSON.stringify(observed) !== JSON.stringify([...expectedDigests].sort())) errors.push("provenance_receipt_subjects_mismatch");
  return [...new Set(errors)];
}

function receiptSchema(receipt) {
  if (!plainRecord(receipt) || !exactKeys(receipt, ["schema", "verifiedAt", "repository", "signerWorkflow", "sourceCommit", "toolchain", "subjects", "transparencyLog", "checks"]) || receipt.schema !== schema) return false;
  if (!Array.isArray(receipt.subjects) || receipt.subjects.some((subject) => !plainRecord(subject) || !exactKeys(subject, ["name", "sha256"]))) return false;
  if (!Array.isArray(receipt.transparencyLog) || receipt.transparencyLog.some((entry) => !plainRecord(entry) || !exactKeys(entry, ["type", "timestamp"]))) return false;
  return plainRecord(receipt.checks) && exactKeys(receipt.checks, ["sigstoreBundle", "githubOidcIdentity", "inTotoSubjects", "slsaBuildDefinition", "transparencyLog"]);
}

function safeSubjectName(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !value.includes("\\") && !value.startsWith("/")
    && value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function plainRecord(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value, keys) { const observed = Object.keys(value); return observed.length === keys.length && observed.every((key) => keys.includes(key)); }

function runGh(args) {
  const result = spawnSync("gh", args, { encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error("gh_attestation_verify_failed");
  return result.stdout;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args.artifact || !args.bundle || !args.repository || !args.signerWorkflow || !args.sourceCommit || !args.out) throw new Error("uso: --artifact <path> --bundle <json> --repository <owner/repo> --signerWorkflow <owner/repo/.github/workflows/file.yml> --sourceCommit <40-hex> --out <receipt.json>");
    const receipt = createProvenanceReceipt(args.artifact, args.bundle, args.repository, args.signerWorkflow, args.sourceCommit);
    writeFileSync(args.out, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
    process.stdout.write(`Proveniência verificada para ${receipt.subjects.length} subject(s).\n`);
  } catch { process.stderr.write("Evidência de proveniência recusada: verification_failed\n"); process.exitCode = 1; }
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) { const name = args[index]; const value = args[index + 1]; if (!name?.startsWith("--") || !value) throw new Error("provenance_evidence_arguments_invalid"); parsed[name.slice(2)] = value; }
  return parsed;
}

function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
