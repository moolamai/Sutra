/**
 * Structured summary compiler — deterministic compaction (no LLM).
 * Run: pnpm --filter @moolam/runtime-harness test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMPACTION_SUMMARY_MARKERS,
  compileStructuredSummary,
  extractCompactionSections,
  renderCompactionSummaryTemplate,
} from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function log(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

test("happy path: extracts constraints/facts/citations and renders fixed template", () => {
  const telemetry = [];
  const state = {
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
    openConstraints: ["ratio >= 2", "refusal:medical-advice"],
    verifiedFacts: ["water boils at 100C at 1atm"],
    citationRefs: ["pack-a#§3"],
    memories: [
      { kind: "constraint", text: "max-steps:3" },
      { kind: "fact", text: "H2O is polar" },
      { kind: "episodic", text: "learner struggled yesterday" },
    ],
    knowledge: [
      { id: "k1", sourceId: "pack-b", citation: "pack-b#fig-1", text: "diagram" },
    ],
  };
  const result = compileStructuredSummary({
    state,
    options: { onTelemetry: (e) => telemetry.push(e) },
  });
  assert.equal(result.ok, true);
  assert.equal(result.usedLlm, false);
  assert.ok(result.summary.startsWith(COMPACTION_SUMMARY_MARKERS.open));
  assert.ok(result.summary.includes("ratio >= 2"));
  assert.ok(result.summary.includes("max-steps:3"));
  assert.ok(result.summary.includes("water boils at 100C at 1atm"));
  assert.ok(result.summary.includes("H2O is polar"));
  assert.ok(result.summary.includes("pack-a#§3"));
  assert.ok(result.summary.includes("pack-b#fig-1"));
  assert.ok(result.summary.includes("learner struggled yesterday"));
  assert.match(result.summaryHash, /^[0-9a-f]{64}$/);
  assert.ok(result.tokensBefore >= result.tokensAfter || result.tokensAfter > 0);

  // Verbatim survival — numeric constraint unchanged.
  assert.ok(result.sections.openConstraints.includes("ratio >= 2"));

  assert.ok(telemetry.some((t) => t.action === "compile" && t.summaryHash));
  assert.ok(!JSON.stringify(telemetry).includes("ratio >= 2"));
  assert.ok(!JSON.stringify(telemetry).includes("learner struggled"));

  log({
    event: "runtime.harness.compaction",
    outcome: "ok",
    case: "compile",
    subjectId: "anika-k",
    summaryHash: result.summaryHash.slice(0, 12),
    tokensBefore: result.tokensBefore,
    tokensAfter: result.tokensAfter,
  });
});

test("invariant: same state → identical summary bytes and hash", () => {
  const state = {
    subjectId: "anika-k",
    openConstraints: ["c2", "c1"],
    verifiedFacts: ["f1"],
    citationRefs: ["ref-a"],
    memories: [{ kind: "refusal", text: "c1" }], // dedupe with openConstraints
  };
  const a = compileStructuredSummary({ state });
  const b = compileStructuredSummary({ state: { ...state } });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.summary, b.summary);
  assert.equal(a.summaryHash, b.summaryHash);
});

test("edge: empty durable state → minimal stub, not error", () => {
  const result = compileStructuredSummary({
    state: { subjectId: "anika-k" },
  });
  assert.equal(result.ok, true);
  assert.equal(result.emptyStub, true);
  assert.ok(result.summary.includes(COMPACTION_SUMMARY_MARKERS.none));
  assert.ok(result.summary.includes(COMPACTION_SUMMARY_MARKERS.constraints));
  assert.ok(result.summary.includes(COMPACTION_SUMMARY_MARKERS.facts));
  assert.ok(result.summary.includes(COMPACTION_SUMMARY_MARKERS.citations));
});

test("edge: second-pass drops episodic only when over token budget", () => {
  const longEpisodic = "e".repeat(2000);
  const result = compileStructuredSummary({
    state: {
      subjectId: "anika-k",
      openConstraints: ["keep-me"],
      verifiedFacts: ["fact-me"],
      citationRefs: ["cite-me"],
      episodicDetail: [longEpisodic],
    },
    options: { maxSummaryTokens: 80 },
  });
  assert.equal(result.ok, true);
  assert.equal(result.episodicDropped, true);
  assert.ok(result.summary.includes("keep-me"));
  assert.ok(result.summary.includes("fact-me"));
  assert.ok(result.summary.includes("cite-me"));
  assert.ok(!result.summary.includes(longEpisodic));
  assert.ok(!result.summary.includes(COMPACTION_SUMMARY_MARKERS.episodic));
});

test("edge: tool loop active → deferred, not silent skip", () => {
  const telemetry = [];
  const result = compileStructuredSummary({
    state: {
      subjectId: "anika-k",
      openConstraints: ["c1"],
    },
    options: {
      toolLoopActive: true,
      onTelemetry: (e) => telemetry.push(e),
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.deferred, true);
  assert.equal(result.failureClass, "deferred_tool_loop");
  assert.ok(telemetry.some((t) => t.outcome === "deferred"));
});

test("sovereignty: missing subjectId rejected; no content in telemetry", () => {
  const telemetry = [];
  const bad = compileStructuredSummary({
    state: { subjectId: "  ", openConstraints: ["secret-constraint"] },
    options: { onTelemetry: (e) => telemetry.push(e) },
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.failureClass, "missing_subject");
  assert.ok(!JSON.stringify(telemetry).includes("secret-constraint"));
});

test("source: compaction module has no model.generate path", () => {
  const src = readFileSync(
    join(__dirname, "../src/compaction.ts"),
    "utf8",
  );
  assert.ok(!/model\.generate/.test(src));
  assert.ok(!/generateStream/.test(src));
  assert.ok(!/@moolam\/cognitive-core/.test(src));
});

test("unit: extract + render preserve verbatim numeric constraint", () => {
  const extracted = extractCompactionSections({
    subjectId: "anika-k",
    openConstraints: ["  ratio>=2  "],
  });
  assert.equal(extracted.ok, true);
  assert.equal(extracted.sections.openConstraints[0], "  ratio>=2  ");
  const rendered = renderCompactionSummaryTemplate(extracted.sections);
  assert.ok(rendered.includes("-   ratio>=2  "));
});
