/**
 * Per-behavior degradation registry unit fixtures.
 * Fixtures: fixtures/degradation-behavior/
 * Run: pnpm --filter @moolam/runtime-harness test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEGRADATION_BEHAVIORS,
  DEGRADATION_BEHAVIOR_FIXTURE_RELPATH,
  DEGRADATION_BEHAVIOR_SIGNAL_CODES,
  assertBehaviorCorpusCoverage,
  invokeModelDependency,
  invokeSyncDependency,
  loadDegradationRegistry,
  parseDegradationBehaviorCase,
  runDegradationBehaviorCase,
} from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = join(__dirname, "..");
const FIXTURE_DIR = join(PKG, DEGRADATION_BEHAVIOR_FIXTURE_RELPATH);

function log(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function loadCorpus() {
  return JSON.parse(
    readFileSync(join(FIXTURE_DIR, "cases.json"), "utf8").replace(/\r\n/g, "\n"),
  );
}

function loadManifest() {
  return JSON.parse(
    readFileSync(join(FIXTURE_DIR, "manifest.json"), "utf8").replace(
      /\r\n/g,
      "\n",
    ),
  );
}

test("fixture: degradation-behavior corpus wired; covers every Behavior", () => {
  const manifest = loadManifest();
  const corpus = loadCorpus();
  assert.equal(manifest.comparePolicy, "exact-behavior-signal");
  assert.equal(manifest.fixtureFile, "cases.json");
  assert.ok(corpus.cases.length >= 7);

  const parsed = [];
  for (const raw of corpus.cases) {
    const p = parseDegradationBehaviorCase(raw);
    assert.equal(p.ok, true, `${raw.id}: ${p.detail}`);
    assert.ok(p.case.specId, `${raw.id}: specId required`);
    assert.ok(p.case.protects, `${raw.id}: protects comment required`);
    parsed.push(p.case);
  }

  const coverage = assertBehaviorCorpusCoverage(parsed);
  assert.equal(coverage.ok, true, coverage.detail);

  const ids = new Set(parsed.map((c) => c.id));
  for (const required of manifest.requiredCases) {
    assert.ok(ids.has(required), `missing case ${required}`);
  }
  for (const behavior of DEGRADATION_BEHAVIORS) {
    assert.ok(
      parsed.some((c) => c.expectedBehavior === behavior),
      `no case for ${behavior}`,
    );
    assert.equal(
      DEGRADATION_BEHAVIOR_SIGNAL_CODES[behavior],
      parsed.find((c) => c.expectedBehavior === behavior).expectedSignalCode ||
        DEGRADATION_BEHAVIOR_SIGNAL_CODES[behavior],
    );
  }

  const raw = readFileSync(join(FIXTURE_DIR, "cases.json"), "utf8");
  assert.ok(!/\blearner\b/i.test(raw), "no learner content in fixtures");
  assert.ok(!/\bNaN\b/.test(raw));
});

test("happy path: every behavior case matches Behavior + signal (no fabrication)", async () => {
  const corpus = loadCorpus();
  const telemetry = [];
  const advisories = [];

  for (const raw of corpus.cases) {
    const result = await runDegradationBehaviorCase(raw, {
      onTelemetry: (e) => telemetry.push(e),
      onAdvisory: (s) => advisories.push(s),
    });
    assert.equal(result.ok, true, `${raw.id}: ${result.detail}`);
    assert.equal(result.behavior, raw.expectedBehavior);
    assert.equal(result.signalCode, raw.expectedSignalCode);
    assert.equal(result.fabricated, false);
    assert.equal(result.silentWriteRetry, false);
    assert.equal(result.subjectId, raw.subjectId);
    log({
      event: "runtime.harness.degradation_behavior",
      outcome: "ok",
      caseId: result.caseId,
      behavior: result.behavior,
      signalCode: result.signalCode,
      subjectId: result.subjectId,
      deviceId: result.deviceId,
      advisoryOutcome: result.advisoryOutcome,
    });
  }

  assert.ok(
    advisories.every((a) => a.event === "runtime.harness.degradation_advisory"),
  );
  assert.ok(!JSON.stringify(advisories).includes("learner"));
  assert.ok(
    telemetry.some((t) => t.action === "invoke" && t.outcome === "advisory"),
  );
});

test("edge: partial outage — model up, sync write down with hard_stop signal", async () => {
  const loaded = loadDegradationRegistry();
  const advisories = [];

  const modelUp = await invokeModelDependency({
    registry: loaded.registry,
    operation: "read",
    subjectId: "anika-k",
    invoke: async () => ({ local: true }),
  });
  assert.equal(modelUp.ok, true);
  assert.equal(modelUp.degraded, false);

  const syncDown = await invokeSyncDependency({
    registry: loaded.registry,
    operation: "write",
    subjectId: "anika-k",
    invoke: async () => {
      throw new Error("sync down");
    },
    onAdvisory: (s) => advisories.push(s),
  });
  assert.equal(syncDown.ok, false);
  assert.equal(syncDown.behavior, "hard_stop");
  assert.equal(syncDown.signalCode, "DEGRADE_HARD_STOP_WRITE");
  assert.equal(advisories[0].dependency, "sync");
});

test("edge: concurrent writes same subjectId — each hard-stops once, no silent retry", async () => {
  const corpus = loadCorpus();
  const writeCase = corpus.cases.find(
    (c) => c.id === "behavior-hard-stop-sync-write",
  );
  assert.ok(writeCase);

  let invokeTotal = 0;
  const loaded = loadDegradationRegistry();
  const runOnce = () =>
    invokeSyncDependency({
      registry: loaded.registry,
      operation: "write",
      subjectId: "anika-k",
      invoke: async () => {
        invokeTotal += 1;
        throw new Error("concurrent sync write fail");
      },
      rollback: async () => {},
    });

  const [a, b] = await Promise.all([runOnce(), runOnce()]);
  assert.equal(a.ok, false);
  assert.equal(b.ok, false);
  assert.equal(a.behavior, "hard_stop");
  assert.equal(b.behavior, "hard_stop");
  assert.equal(a.silentWriteRetry, false);
  assert.equal(b.silentWriteRetry, false);
  assert.equal(invokeTotal, 2, "each turn invokes once — no shared silent retry");
});

test("edge: replayed idempotency key — second claim not first; durable not double-applied", async () => {
  const corpus = loadCorpus();
  const writeCase = corpus.cases.find(
    (c) => c.id === "behavior-hard-stop-partial-failure",
  );
  assert.ok(writeCase);
  const seen = new Set();

  const first = await runDegradationBehaviorCase(writeCase, {
    seenIdempotencyKeys: seen,
  });
  assert.equal(first.ok, true);
  assert.equal(first.idempotentFirst, true);
  assert.equal(first.rolledBack, true);

  const second = await runDegradationBehaviorCase(writeCase, {
    seenIdempotencyKeys: seen,
  });
  assert.equal(second.ok, true);
  assert.equal(second.idempotentFirst, false);
  assert.equal(second.silentWriteRetry, false);
});

test("sovereignty: missing subjectId rejected; telemetry never carries content", async () => {
  const missing = await runDegradationBehaviorCase({
    id: "missing-subject",
    specId: "degradation-contract",
    protects: "subjectId required",
    subjectId: "",
    dependency: "sync",
    operation: "write",
    forcedFailure: { kind: "timeout", dependency: "cloud-sync" },
    expectedBehavior: "hard_stop",
    expectedSignalCode: "DEGRADE_HARD_STOP_WRITE",
    expectedOk: false,
    expectedDegraded: true,
    allowsFabrication: false,
    allowsSilentWriteRetry: false,
    idempotencyKey: "x",
  });
  assert.equal(missing.ok, false);
  assert.ok(
    missing.failureClass === "schema_violation" ||
      missing.failureClass === "missing_subject",
  );

  const telemetry = [];
  const corpus = loadCorpus();
  await runDegradationBehaviorCase(corpus.cases[0], {
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.ok(
    telemetry.every((t) => t.event === "runtime.harness.degradation_registry"),
  );
  assert.ok(!JSON.stringify(telemetry).includes("fabricated-reply"));
});
