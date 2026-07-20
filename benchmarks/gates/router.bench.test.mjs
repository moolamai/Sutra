/**
 * router.bench — NFR-04 task-router overhead probe.
 * Run: pnpm --filter @moolam/benchmarks test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_REMEDIATION_DEPTH,
  mockFrictionNominal,
  mockFrictionSpike,
  mockMasteryStrong,
  mockMasteryWeakPrereq,
  routeTurn,
} from "../_shared/router_probe.mjs";
import { evaluateP95Gate } from "./check.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const THRESHOLDS = path.join(__dirname, "thresholds.json");
const ROUTER_BENCH = path.join(__dirname, "../router.bench.mjs");

function log(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "benchmarks.router.test", ...event })}\n`,
  );
}

test("happy path: assess→route with mocked state returns guidance, no model call", () => {
  const out = routeTurn({
    subjectId: "bench-subject",
    activeConceptId: "math.ratios",
    friction: mockFrictionNominal(),
    mastery: mockMasteryStrong(),
  });
  assert.equal(out.subjectId, "bench-subject");
  assert.match(out.guidanceDirective, /^GUIDE /);
  assert.doesNotMatch(out.guidanceDirective, /utterance|generate|llm/i);
  assert.ok(out.remediationDepth <= MAX_REMEDIATION_DEPTH);
  log({ outcome: "ok", case: "nominal-route", subjectId: out.subjectId });
});

test("edge: cyclic remediate path hits depth breaker (bounded)", () => {
  const out = routeTurn({
    subjectId: "bench-subject",
    activeConceptId: "math.ratios",
    friction: mockFrictionSpike(),
    mastery: mockMasteryWeakPrereq(),
  });
  assert.ok(out.remediationDepth >= 1);
  assert.ok(out.remediationDepth <= MAX_REMEDIATION_DEPTH);
  assert.match(out.routingRationale, /SPIKE|looped back/i);
  assert.equal(out.mode, "prerequisite-remediation");
  log({
    outcome: "ok",
    case: "depth-breaker",
    subjectId: out.subjectId,
    remediationDepth: out.remediationDepth,
  });
});

test("edge: missing subjectId is validation_failed; zero-sleep mocks only", () => {
  assert.throws(
    () =>
      routeTurn({
        activeConceptId: "math.ratios",
        friction: mockFrictionNominal(),
        mastery: mockMasteryStrong(),
      }),
    (err) => err.failureClass === "validation_failed",
  );
  // Probe surface has no sleep / generate — source must not introduce artificial delay.
  const src = readFileSync(ROUTER_BENCH, "utf8");
  assert.doesNotMatch(src, /sleep|setTimeout|generate\s*\(/i);
  assert.match(src, /routeTurn/);
  log({ outcome: "ok", case: "validation-and-zero-sleep", subjectId: null });
});

test("edge: seeded slowdown trips NFR-04 ceiling; headroom printed", () => {
  const doc = JSON.parse(readFileSync(THRESHOLDS, "utf8"));
  const entry = doc.benches.router;
  assert.ok(entry, "thresholds.json must map router → NFR-04");
  assert.equal(entry.nfrId, "NFR-04");
  assert.equal(entry.p95Ms, 50);
  assert.equal(entry.benchFile, "router.bench.mjs");

  const breach = evaluateP95Gate({
    benchId: "router",
    measuredP95: 99,
    budgetP95: entry.p95Ms,
    nfrId: entry.nfrId,
    subjectId: null,
    deviceId: "test-router-slow",
  });
  assert.equal(breach.ok, false);
  assert.equal(breach.failureClass, "p95_breach");
  assert.ok(breach.headroomPercent < 0);

  const ok = evaluateP95Gate({
    benchId: "router",
    measuredP95: 1,
    budgetP95: entry.p95Ms,
    nfrId: entry.nfrId,
    subjectId: null,
    deviceId: "test-router-ok",
  });
  assert.equal(ok.ok, true);
  assert.ok(ok.headroomPercent > 0);
  log({ outcome: "ok", case: "nfr04-threshold", subjectId: null });
});

test("sovereignty: routeTurn scopes subjectId; rationale has no learner utterance body", () => {
  const a = routeTurn({
    subjectId: "subj-a",
    activeConceptId: "math.ratios",
    friction: mockFrictionSpike(),
    mastery: mockMasteryWeakPrereq(),
  });
  const b = routeTurn({
    subjectId: "subj-b",
    activeConceptId: "math.ratios",
    friction: mockFrictionSpike(),
    mastery: mockMasteryWeakPrereq(),
  });
  assert.equal(a.subjectId, "subj-a");
  assert.equal(b.subjectId, "subj-b");
  assert.notEqual(a.subjectId, b.subjectId);
  assert.doesNotMatch(a.routingRationale, /password|ssn|learner essay/i);
  log({ outcome: "ok", case: "subject-isolation", subjectId: null });
});
