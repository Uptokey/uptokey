/**
 * Builds a scoped matrix from real canonical terminal evidence. Missing runs mean not_executed, not missing code.
 * The default scans output/tui-canonica recursively and selects the latest artifact binding (or source binding).
 * Each generation saves a unique execution copy plus output/tui-canonica/MATRIX.json.
 *   node scripts/tui-frontend-matrix.mjs --evidence-dir <execution-directory>
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const core = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = resolve(core, "../..");
const output = join(workspace, "output/tui-canonica");
const option = (name) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const evidenceRoot = resolve(option("--evidence-dir") ?? output);
if (evidenceRoot !== output && !evidenceRoot.startsWith(output + sep)) throw new Error("Evidence must be inside output/tui-canonica.");
if (!existsSync(evidenceRoot)) throw new Error("Canonical evidence directory does not exist.");
const link = (file) => relative(output, file).split(sep).join("/");
const LOCALES = ["pt-BR", "en", "es", "fr", "de", "it", "ja", "ko", "zh-CN", "ar"].map((lang) => `locale-${lang}`);

/** Canonical capability map → terminal journeys and the scope of their evidence. */
const J = {
  J01: { runs: ["boot", "connect", "exit"], gap: null },
  J02: { runs: ["connect", "chat", "real-provider"], gap: null },
  J03: { runs: ["reopen"], gap: null },
  J04: { runs: ["homonym"], gap: null },
  J05: { runs: ["folder"], gap: null },
  J06: { runs: ["chat", "paste"], gap: null },
  J07: { runs: ["scroll"], gap: null },
  J08: { runs: ["copy", "panels-more"], gap: null },
  J09: { runs: ["edit", "conflict", "app"], gap: null },
  J10: { runs: ["conflict"], gap: null },
  J11: { runs: ["runner", "runner-real"], gap: null },
  J12: { runs: ["switch", "switch-project"], gap: null },
  J13: { runs: ["delegate"], gap: null },
  J14: { runs: ["revoke"], gap: null },
  J15: { runs: ["export"], gap: null },
  J16: { runs: ["temporary"], gap: null },
  J17: { runs: ["git", "lsp", "debug"], gap: null },
  J18: { runs: ["tools", "real-web", "search", "real-search"], gap: null },
  J19: { runs: ["voice", "real-transcription", "real-voice"], gap: null },
  J20: { runs: [...LOCALES, "reader", "reader-nvda"], gap: null },
  J21: { runs: ["network", "cancel", "restart"], gap: null },
  J22: { runs: ["boot-bundle", "chat-bundle", "connect-bundle", "edit-bundle", "folder-bundle", "copy-bundle", "temporary-bundle", "lsp-bundle", "debug-bundle", "update", "npm-install"], gap: "Terminal bundle journeys do not establish a signed release installer or current production promotion." },
};

const M = {
  M00: { evidence: ["M00-base.json"], state: null },
  M01: { journeys: ["J01"], state: null },
  M02: { journeys: ["J02", "J21"], state: null },
  M03: { journeys: ["J02", "J03", "J04"], state: null },
  M04: { journeys: ["J06", "J07", "J08"], state: null },
  M05: { journeys: ["J05"], state: null },
  M06: { journeys: ["J09", "J10"], state: null },
  M07: { journeys: ["J11"], state: null },
  M08: { journeys: ["J17"], state: null },
  M09: { journeys: ["J18"], state: null },
  M10: { journeys: ["J13"], state: null },
  M11: { journeys: ["J14", "J16", "J12"], state: null },
  M12: { journeys: ["J19"], state: null },
  M13: { journeys: ["J20"], evidence: ["i18n-coverage.json"], state: null },
  M14: { journeys: ["J07", "J21"], evidence: ["bench.json", "bench-bundle.json"], state: null },
  M15: { journeys: ["J22"], evidence: [], state: null },
};

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    return entry.isDirectory() ? files(file) : entry.isFile() && entry.name.endsWith(".json") ? [file] : [];
  });
}
const documents = files(evidenceRoot).flatMap((file) => {
  try { return [{ file, data: JSON.parse(readFileSync(file, "utf8")) }]; }
  catch { return []; }
});
const reports = documents.filter(({ data }) => typeof data.journey === "string" && ["passed", "failed", "partial", "not_executed"].includes(data.result));
function binding(data) {
  return {
    kind: /^bundle\b/.test(data.runtime ?? "") ? "artifact" : "source",
    runtime: data.runtime ?? null,
    sourceHash: data.sourceHash ?? null,
    artifactManifestSha256: data.artifactManifestSha256 ?? null,
  };
}
function bindingId(value) { return `${value.kind}:${value.artifactManifestSha256 ?? "unrecorded"}:source:${value.sourceHash ?? "unrecorded"}`; }
const groups = new Map();
for (const report of reports) {
  const value = binding(report.data), id = bindingId(value);
  if (!groups.has(id)) groups.set(id, { id, binding: value, reports: [] });
  groups.get(id).reports.push(report);
}
const newest = (a, b) => String(b.data.date ?? "").localeCompare(String(a.data.date ?? "")) || b.file.localeCompare(a.file);
const availableBindings = [...groups.values()].map((group) => ({
  ...group, newestAt: [...group.reports].sort(newest)[0]?.data.date ?? null,
})).sort((a, b) => Number(b.binding.kind === "artifact") - Number(a.binding.kind === "artifact") || String(b.newestAt ?? "").localeCompare(String(a.newestAt ?? "")));
const selected = option("--binding") ? availableBindings.find((group) => group.id === option("--binding")) : availableBindings[0];
if (option("--binding") && !selected) throw new Error("Requested binding has no reports in the selected evidence.");
const currentReports = selected?.reports ?? [];
const aliases = { reader: ["reader", "linear"] };
function proofFiles(file) {
  return [file, file.replace(/\.json$/, ".txt"), file.replace(/\.json$/, ".trace.jsonl")].filter(existsSync).map(link);
}
function run(name) {
  const bundled = name.endsWith("-bundle"), logical = bundled ? name.slice(0, -7) : name;
  const names = aliases[logical] ?? [logical];
  const report = currentReports.filter(({ data }) => names.includes(data.journey) && (!bundled || binding(data).kind === "artifact")).sort(newest)[0];
  if (!report) return { name, result: "not_executed", evidence: [] };
  const { data, file } = report;
  const unbound = !data.sourceHash || (binding(data).kind === "artifact" && !data.artifactManifestSha256);
  const result = data.result === "passed" && (data.sourceStable === false || unbound) ? "partial" : data.result;
  return { name, journey: data.journey, result, reportedResult: data.result, date: data.date ?? null,
    error: data.error ?? null, binding: binding(data), sourceStable: data.sourceStable ?? null,
    remaining: data.sourceStable === false ? "Sources changed during this execution." : unbound ? "Execution lacks a recorded source/artifact binding." : null,
    evidence: proofFiles(file) };
}
const aggregate = (results, gap = false) => results.includes("failed") ? "failed"
  : results.length && results.every((value) => value === "passed") ? gap ? "partial" : "passed"
  : results.some((value) => value === "passed" || value === "partial") ? "partial" : "not_executed";
const journeys = {};
for (const [id, spec] of Object.entries(J)) {
  const runs = spec.runs.map(run), missing = runs.filter((entry) => entry.result === "not_executed").map((entry) => entry.name);
  journeys[id] = { result: aggregate(runs.map((entry) => entry.result), Boolean(spec.gap)), runs,
    remaining: [spec.gap, missing.length ? `Not executed in this binding: ${missing.join(", ")}.` : null].filter(Boolean) };
}
const productionDirectory = resolve(option("--production-dir") ?? join(core, "dist/tui"));
const productionManifest = join(productionDirectory, "BUILD_INFO.json");
let production = { result: "not_executed", evidence: [], remaining: "No matching current production artifact and explicit promotion proof in the selected evidence." };
if (selected?.binding.artifactManifestSha256 && existsSync(productionManifest)) {
  const manifestSha256 = createHash("sha256").update(readFileSync(productionManifest)).digest("hex");
  if (manifestSha256 === selected.binding.artifactManifestSha256) {
    const requested = option("--promotion-evidence");
    const candidates = requested ? [{ file: resolve(requested), data: JSON.parse(readFileSync(resolve(requested), "utf8")) }] : documents;
    const proof = candidates.find(({ data }) => data.result === "passed" && data.artifactManifestSha256 === manifestSha256 &&
      (data.kind === "promotion" || data.productionPromoted === true || data.promotion?.result === "passed"));
    production = { result: proof ? "passed" : "partial", manifestSha256, evidence: [link(productionManifest), ...(proof ? [link(proof.file)] : [])],
      remaining: proof ? null : "Current production manifest matches; explicit promotion verification was not recorded in the selected evidence." };
  }
}
const packages = {};
for (const [id, spec] of Object.entries(M)) {
  const linked = (spec.journeys ?? []).map((journey) => journeys[journey].result);
  const evidence = documents.filter(({ file }) => (spec.evidence ?? []).some((name) => file.endsWith(sep + name))).map(({ file }) => link(file));
  const results = id === "M15" ? [...linked, production.result] : linked;
  packages[id] = { state: results.length ? aggregate(results) : evidence.length ? "partial" : "not_executed",
    journeys: spec.journeys ?? [], evidence: id === "M15" ? [...evidence, ...production.evidence] : evidence,
    ...(id === "M15" ? { production } : {}), assessment: "Execution evidence only; this state does not assert whether the feature exists or full product acceptance." };
}
const counts = Object.values(journeys).reduce((total, entry) => ({ ...total, [entry.result]: (total[entry.result] ?? 0) + 1 }), {});
const generatedAt = new Date().toISOString();
const generation = join(output, `matrix-${generatedAt.replace(/[:.]/g, "-")}-${process.pid}`);
mkdirSync(generation, { recursive: true });
const matrix = {
  generatedAt, scope: { evidenceDirectory: link(evidenceRoot) || ".", selection: "latest artifact binding, otherwise latest source binding; --binding overrides",
    selectedBinding: selected ? { id: selected.id, ...selected.binding, newestAt: selected.newestAt } : null,
    availableBindings: availableBindings.map(({ id, binding, newestAt, reports }) => ({ id, ...binding, newestAt, reports: reports.length })) },
  runtimeScope: [...new Set(currentReports.map(({ data }) => JSON.stringify({ terminal: data.terminal ?? null, core: data.core ?? null, runtime: data.runtime ?? null })))].map((value) => JSON.parse(value)),
  assessment: "Scoped observations from linked reports. Missing results are unexecuted here. Scripted providers, terminal tests and candidate artifacts do not establish global homologation, real-provider operation, signed distribution or production promotion.",
  journeys, packages, totals: counts, executionCopy: link(join(generation, "MATRIX.json")),
};
const serialized = `${JSON.stringify(matrix, null, 2)}\n`;
writeFileSync(join(generation, "MATRIX.json"), serialized);
writeFileSync(join(output, "MATRIX.json"), serialized);
console.log(JSON.stringify({ totals: counts, matrix: join(output, "MATRIX.json"), executionCopy: join(generation, "MATRIX.json") }));
