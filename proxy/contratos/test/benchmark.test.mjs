import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseModelCard,
  parseBenchmarkDefinition,
  parseObservation,
  parseBenchmarkRun,
  parseRankingView,
  clampBenchmarkPageSize,
  assertActiveEvalReady,
  definitionVersionForParameters,
  BENCHMARK_LIMITS,
  BENCHMARK_ERROR_CODES,
  isBenchmarkErrorCode,
} from "../benchmark.js";

const NOW = new Date().toISOString();
const FUTURE = new Date(Date.now() + 3_600_000).toISOString();

describe("E2-22 W0 ModelCard", () => {
  it("parses card and preserves unknown fields; unknown toolSupport stays unknown", () => {
    const card = parseModelCard({
      providerId: "ollama",
      modelId: "llama3",
      revision: "q4",
      modalities: ["text"],
      contextLimit: null,
      toolSupport: "unknown",
      connectionState: "connected",
      source: "catalog-projection",
      observedAt: NOW,
      customFlag: "keep-me",
    });
    assert.equal(card.toolSupport, "unknown");
    assert.equal(card.contextLimit, null);
    assert.equal(card.customFlag, "keep-me");
  });

  it("does not coerce missing toolSupport to false", () => {
    const card = parseModelCard({
      providerId: "x",
      modelId: "y",
      modalities: [],
      connectionState: "unknown",
      source: "declared",
      observedAt: NOW,
    });
    assert.equal(card.toolSupport, "unknown");
  });
});

describe("E2-22 W0 BenchmarkDefinition", () => {
  it("requires finite budget and deadline", () => {
    const def = parseBenchmarkDefinition({
      id: "syn-1",
      version: "1",
      datasetHash: "abc",
      caseRefs: ["c1"],
      rubric: { version: "r1" },
      sampleCount: 1,
      parameters: { temp: 0 },
      budget: { maxCostMicros: 1000 },
      deadline: FUTURE,
      privacyScope: "local",
    });
    assert.equal(def.id, "syn-1");
    assert.throws(
      () =>
        parseBenchmarkDefinition({
          id: "syn-1",
          version: "1",
          datasetHash: "abc",
          caseRefs: ["c1"],
          rubric: { version: "r1" },
          sampleCount: 1,
          parameters: {},
          budget: {},
          deadline: FUTURE,
          privacyScope: "local",
        }),
      /benchmark_definition_budget_invalid/,
    );
  });

  it("caps first-run cases at 20 by default", () => {
    const refs = Array.from({ length: 21 }, (_, i) => `c${i}`);
    assert.throws(
      () =>
        parseBenchmarkDefinition({
          id: "syn-1",
          version: "1",
          datasetHash: "abc",
          caseRefs: refs,
          rubric: { version: "r1" },
          sampleCount: 1,
          parameters: {},
          budget: { maxTokens: 100 },
          deadline: FUTURE,
          privacyScope: "local",
        }),
      /benchmark_definition_cases_invalid/,
    );
  });
});

describe("E2-22 W0 Observation", () => {
  it("allows null value (unknown ≠ 0) and probe metric naming", () => {
    const obs = parseObservation({
      kind: "probe",
      modelRef: { providerId: "ollama", modelId: "llama3" },
      metric: "endpoint_latency_ms",
      value: null,
      unit: "ms",
      measuredAt: NOW,
      status: "ok",
    });
    assert.equal(obs.value, null);
    assert.equal(obs.kind, "probe");
    assert.throws(
      () =>
        parseObservation({
          kind: "probe",
          modelRef: { providerId: "ollama", modelId: "llama3" },
          metric: "generation_ttft_ms",
          value: 12,
          unit: "ms",
          measuredAt: NOW,
          status: "ok",
        }),
      /observation_probe_metric_invalid/,
    );
  });
});

describe("E2-22 W0 BenchmarkRun + RankingView", () => {
  it("limits comparison to 4 models", () => {
    assert.throws(
      () =>
        parseBenchmarkRun({
          id: "run1",
          definitionVersion: "syn-1@1",
          modelRefs: [
            { providerId: "a", modelId: "1" },
            { providerId: "a", modelId: "2" },
            { providerId: "a", modelId: "3" },
            { providerId: "a", modelId: "4" },
            { providerId: "a", modelId: "5" },
          ],
          completedCases: 0,
          total: 1,
          perCaseState: {},
          costKnown: "unknown",
        }),
      /benchmark_run_models_invalid/,
    );
  });

  it("rejects implicit_global ranking cohort", () => {
    assert.throws(
      () =>
        parseRankingView({
          filter: {},
          metric: "latency",
          cohort: "implicit_global",
          method: "mean",
          sampleCount: 0,
          sourceDate: NOW,
          exclusions: [],
        }),
      /ranking_view_no_implicit_global/,
    );
  });

  it("parameter change yields distinct definition version", () => {
    const a = definitionVersionForParameters("syn", { temp: 0 }, "ds1");
    const b = definitionVersionForParameters("syn", { temp: 0.7 }, "ds1");
    assert.notEqual(a, b);
  });
});

describe("E2-22 W0 defaults + errors", () => {
  it("pagination defaults 50/200", () => {
    assert.equal(clampBenchmarkPageSize(), BENCHMARK_LIMITS.pageDefault);
    assert.equal(clampBenchmarkPageSize(999), BENCHMARK_LIMITS.pageMax);
  });

  it("lists expected error codes", () => {
    for (const code of [
      "benchmark_incompatible",
      "stale_observation",
      "benchmark_budget_exceeded",
      "benchmark_cancelled",
      "source_unavailable",
      "insufficient_samples",
    ]) {
      assert.equal(isBenchmarkErrorCode(code), true);
      assert.ok(BENCHMARK_ERROR_CODES.includes(code));
    }
  });

  it("assertActiveEvalReady accepts finite budget+deadline", () => {
    const def = assertActiveEvalReady({
      id: "syn-1",
      version: "1",
      datasetHash: "abc",
      caseRefs: ["c1"],
      rubric: { version: "r1" },
      sampleCount: 1,
      parameters: {},
      budget: { maxCostMicros: 100 },
      deadline: FUTURE,
      privacyScope: "local",
    });
    assert.equal(def.id, "syn-1");
  });
});
