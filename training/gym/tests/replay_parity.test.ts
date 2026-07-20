/**
 * Anti-cheat charter — trajectory replay parity CI (production path = training path).
 * Expanded production trajectory corpus across capability domains; frame-level
 * diff on failure; canonical serialization for comparison.
 *
 * Run: pnpm --filter @moolam/training-gym test
 * Gate: pnpm --filter @moolam/training-gym parity:check
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalizeFramesJson,
  loadGoldenTurnCorpus,
  unifiedDiff,
} from "../src/harness_bridge.mjs";
import {
  assertByteIdenticalCanonicalFrames,
  assertFrameSequenceIdentity,
  frameIdentity,
  GYM_FRAME_COMPARE_LIMIT,
  GYM_REPLAY_CORPUS_LIMIT,
  PARITY_CORPUS_DOMAINS,
  replayProductionTrajectoryThroughGym,
  runTrajectoryReplayParityGate,
} from "../src/frame_parity.mjs";
import {
  assertParityCorpusMultiDomainCoverage,
  loadProductionTrajectoryParityCorpus,
  replayParityCorpusEntryThroughGymEnv,
  runProductionTrajectoryParitySuite,
} from "../src/parity_corpus.mjs";
import {
  assertParityFixtureRunbookCoherence,
  loadParityFixtureRunbook,
  PARITY_FIXTURE_RUNBOOK_RELPATH,
} from "../src/parity_runbook.mjs";
import {
  decideGymReplayParityRun,
  GYM_REPLAY_PARITY_PATH_PREFIXES,
  pathTriggersGymReplayParity,
  selectParityTriggeringPaths,
} from "../scripts/detect-parity-ci-paths.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GYM_ROOT = join(__dirname, "..");
const REPO_ROOT = join(GYM_ROOT, "../..");
const CHARTER_PATH = join(GYM_ROOT, "charter.md");
const CI_YML = join(REPO_ROOT, ".github/workflows/ci.yml");
const PKG_JSON = join(GYM_ROOT, "package.json");

function log(event: Record<string, unknown>) {
  process.stdout.write(
    `${JSON.stringify({ event: "training.gym.replay_parity.test", ...event })}\n`,
  );
}

test("charter governance document encodes production-path invariant", () => {
  const charter = readFileSync(CHARTER_PATH, "utf8");
  assert.ok(charter.includes("production harness code path"));
  assert.ok(charter.includes("@moolam/runtime-harness"));
  assert.ok(charter.includes("sequenceIndex"));
  assert.ok(charter.includes("payload hash"));
  assert.ok(charter.includes("invalidates training") || charter.includes("Training void"));
  assert.ok(charter.includes("TURN_COMPLETE"));
  assert.ok(charter.includes("HARNESS_ERROR"));
  assert.ok(charter.includes("parity:check") || charter.includes("deps:lint"));
  assert.ok(!charter.includes("Math.random"));
  log({ outcome: "ok", case: "charter-doc", subjectId: null });
});

test("happy path: CI gate replays production corpus with byte-identical canonical frames", () => {
  const telemetry: object[] = [];
  const gate = runTrajectoryReplayParityGate({
    subjectId: "subj-gym-unit-gate",
    deviceId: "dev-gym-unit-gate",
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(gate.ok, true, `${gate.failureClass}: ${gate.detail}\n${gate.diff}`);
  assert.ok(gate.turnCount >= 1);
  assert.ok(gate.turnCount <= GYM_REPLAY_CORPUS_LIMIT);
  assert.ok(gate.domainCount >= PARITY_CORPUS_DOMAINS.length);
  assert.equal(gate.subjectId, "subj-gym-unit-gate");
  assert.equal(gate.deviceId, "dev-gym-unit-gate");

  const loaded = loadGoldenTurnCorpus();
  assert.equal(loaded.ok, true);
  for (const fixture of loaded.fixtures) {
    const result = replayProductionTrajectoryThroughGym(fixture);
    assert.equal(result.ok, true, `${fixture.id}: ${result.detail ?? ""}`);
    const byteCheck = assertByteIdenticalCanonicalFrames(
      fixture.expectedFrames,
      result.frames,
      { turnId: fixture.id },
    );
    assert.equal(byteCheck.ok, true, `${fixture.id}\n${byteCheck.diff}`);
    assert.equal(
      canonicalizeFramesJson(fixture.expectedFrames),
      canonicalizeFramesJson(result.frames),
    );

    for (let i = 0; i < result.frames.length; i += 1) {
      const exp = frameIdentity(fixture.expectedFrames[i]);
      const act = frameIdentity(result.frames[i]);
      assert.ok(exp && act);
      assert.equal(act.sequenceIndex, exp.sequenceIndex);
      assert.equal(act.type, exp.type);
      assert.equal(act.payloadHash, exp.payloadHash);
    }

    const terminal = result.frames[result.frames.length - 1];
    assert.ok(
      terminal?.type === "TURN_COMPLETE" || terminal?.type === "HARNESS_ERROR",
      `${fixture.id} must terminate on production terminal frame`,
    );
  }

  assert.ok(
    telemetry.some(
      (t) =>
        (t as { phase?: string; outcome?: string }).phase === "gate" &&
        (t as { outcome?: string }).outcome === "ok",
    ),
  );
  assert.ok(
    telemetry.every(
      (t) => (t as { event?: string }).event === "training.gym.replay_parity",
    ),
  );
  assert.ok(!JSON.stringify(telemetry).includes("consider ratio parts"));
  log({
    outcome: "ok",
    case: "ci-gate-byte-identical",
    subjectId: gate.subjectId,
    deviceId: gate.deviceId,
    turnCount: gate.turnCount,
    domainCount: gate.domainCount,
  });
});

test("happy path: production trajectory corpus spans multiple domains", () => {
  const telemetry: object[] = [];
  const corpus = loadProductionTrajectoryParityCorpus({
    deviceId: "dev-parity-domains",
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(corpus.ok, true, `${corpus.failureClass}: ${corpus.detail}`);
  assert.ok(corpus.turnCount >= PARITY_CORPUS_DOMAINS.length);
  assert.equal(corpus.domainCount, PARITY_CORPUS_DOMAINS.length);

  const coverage = assertParityCorpusMultiDomainCoverage(corpus);
  assert.equal(coverage.ok, true, coverage.detail);

  for (const domain of PARITY_CORPUS_DOMAINS) {
    assert.ok(
      corpus.entries.some((e) => e.domain === domain),
      `domain ${domain} must have ≥1 recorded trajectory`,
    );
  }

  assert.ok(
    telemetry.some(
      (t) =>
        (t as { phase?: string; outcome?: string }).phase === "corpus_load" &&
        (t as { outcome?: string }).outcome === "ok",
    ),
  );
  assert.ok(!JSON.stringify(telemetry).includes("consider ratio parts"));
  log({
    outcome: "ok",
    case: "multi-domain-corpus",
    subjectId: null,
    turnCount: corpus.turnCount,
    domainCount: corpus.domainCount,
    domains: corpus.domains,
  });
});

test("happy path: GymEnv suite replays full corpus with canonical frame identity", async () => {
  const telemetry: object[] = [];
  const suite = await runProductionTrajectoryParitySuite({
    subjectId: "subj-gym-parity-suite",
    deviceId: "dev-gym-parity-suite",
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(
    suite.ok,
    true,
    `${suite.failureClass}: ${suite.detail}\n${suite.diff}`,
  );
  assert.ok(suite.turnCount >= PARITY_CORPUS_DOMAINS.length);
  assert.equal(suite.domainCount, PARITY_CORPUS_DOMAINS.length);
  assert.ok(
    telemetry.some(
      (t) =>
        (t as { phase?: string; outcome?: string }).phase === "suite" &&
        (t as { outcome?: string }).outcome === "ok",
    ),
  );
  log({
    outcome: "ok",
    case: "gym-env-corpus-suite",
    subjectId: suite.subjectId,
    deviceId: suite.deviceId,
    turnCount: suite.turnCount,
    domainCount: suite.domainCount,
  });
});

test("edge: frame drift fails loudly with frame-level diff — never auto-updates golden", () => {
  const loaded = loadGoldenTurnCorpus();
  assert.equal(loaded.ok, true);
  const fixture = loaded.fixtures[0];
  assert.ok(fixture);

  const result = replayProductionTrajectoryThroughGym(fixture);
  assert.equal(result.ok, true);

  const drifted = structuredClone(result.frames);
  assert.ok(drifted.length > 1);
  const target = drifted[1] as Record<string, unknown>;
  if (typeof target.delta === "string") {
    target.delta = `${target.delta}__DRIFT__`;
  } else {
    target.type = "ANSWER_DELTA";
  }

  const byteCheck = assertByteIdenticalCanonicalFrames(
    fixture.expectedFrames,
    drifted,
    { turnId: fixture.id },
  );
  assert.equal(byteCheck.ok, false);
  assert.ok(byteCheck.failingFrameIndex >= 0);
  assert.ok(typeof byteCheck.failingFrameType === "string");
  assert.ok(byteCheck.diff.includes("---") || byteCheck.diff.includes("@@"));
  assert.ok(byteCheck.diff.length > 0);

  const identity = assertFrameSequenceIdentity(
    fixture.expectedFrames,
    drifted,
  );
  assert.equal(identity.ok, false);

  const onDisk = readFileSync(CHARTER_PATH, "utf8");
  assert.ok(onDisk.includes("Never auto-update"));
  log({
    outcome: "rejected",
    case: "drift-loud",
    subjectId: fixture.subjectId,
    frameIndex: byteCheck.failingFrameIndex,
    frameType: byteCheck.failingFrameType,
    failureClass: "canonical_drift",
  });
});

test("edge: truncated / invalid stream yields real harness HARNESS_ERROR — not a gym mock", () => {
  const loaded = loadGoldenTurnCorpus();
  assert.equal(loaded.ok, true);
  const fixture = loaded.fixtures.find((f) => f.id === "harness-error-terminal");
  assert.ok(fixture, "harness-error-terminal golden required");

  const result = replayProductionTrajectoryThroughGym(fixture);
  assert.equal(result.ok, true);
  const terminal = result.frames[result.frames.length - 1];
  assert.equal(terminal?.type, "HARNESS_ERROR");
  assert.equal(
    (terminal as { code?: string }).code,
    "STREAM_TRUNCATED",
  );
  assert.equal(typeof terminal?.sequenceIndex, "number");
  assert.equal(terminal?.subjectId, fixture.subjectId);
  assert.ok(!(terminal as { gymMock?: boolean }).gymMock);

  const byteCheck = assertByteIdenticalCanonicalFrames(
    fixture.expectedFrames,
    result.frames,
    { turnId: fixture.id },
  );
  assert.equal(byteCheck.ok, true);
  log({
    outcome: "ok",
    case: "real-harness-error",
    subjectId: fixture.subjectId,
    frameType: "HARNESS_ERROR",
    domain: "harness_error",
  });
});

test("edge: invalid tool envelope yields real TOOL_STATUS error from production path", () => {
  const loaded = loadGoldenTurnCorpus();
  assert.equal(loaded.ok, true);
  const fixture = loaded.fixtures.find((f) => f.id === "correction-loop");
  assert.ok(fixture, "correction-loop golden required");

  const result = replayProductionTrajectoryThroughGym(fixture);
  assert.equal(result.ok, true);
  const errorStatus = result.frames.find(
    (f) =>
      f?.type === "TOOL_STATUS" &&
      (f as { status?: string }).status === "error",
  );
  assert.ok(errorStatus, "expected real TOOL_STATUS error frame");
  assert.ok(!(errorStatus as { gymMock?: boolean }).gymMock);
  assert.equal(errorStatus?.subjectId, fixture.subjectId);

  const byteCheck = assertByteIdenticalCanonicalFrames(
    fixture.expectedFrames,
    result.frames,
    { turnId: fixture.id },
  );
  assert.equal(byteCheck.ok, true);
  log({
    outcome: "ok",
    case: "real-tool-status-error",
    subjectId: fixture.subjectId,
    frameType: "TOOL_STATUS",
    domain: "correction",
  });
});

test("edge: idempotent replay of same recorded input yields identical frames", () => {
  const loaded = loadGoldenTurnCorpus();
  assert.equal(loaded.ok, true);
  const fixture = loaded.fixtures[0];
  assert.ok(fixture);

  const first = replayProductionTrajectoryThroughGym(fixture);
  const second = replayProductionTrajectoryThroughGym(fixture);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(
    canonicalizeFramesJson(first.frames),
    canonicalizeFramesJson(second.frames),
  );
  log({
    outcome: "ok",
    case: "idempotent-replay",
    subjectId: first.subjectId,
    deviceId: first.deviceId,
  });
});

test("edge: GymEnv corpus entry is idempotent under repeated golden_replay", async () => {
  const corpus = loadProductionTrajectoryParityCorpus({
    deviceId: "dev-parity-idemp",
  });
  assert.equal(corpus.ok, true);
  const entry = corpus.entries[0];
  assert.ok(entry);

  const first = await replayParityCorpusEntryThroughGymEnv(entry, { seed: 7 });
  const second = await replayParityCorpusEntryThroughGymEnv(entry, { seed: 7 });
  assert.equal(first.ok, true, first.detail ?? "");
  assert.equal(second.ok, true, second.detail ?? "");
  assert.equal(first.canonicalJson, second.canonicalJson);
  log({
    outcome: "ok",
    case: "gym-env-idempotent",
    subjectId: entry.subjectId,
    turnId: entry.id,
    domain: entry.domain,
  });
});

test("sovereignty: telemetry metadata-only; missing subjectId rejected", () => {
  const loaded = loadGoldenTurnCorpus();
  assert.equal(loaded.ok, true);
  const fixture = loaded.fixtures[0];
  assert.ok(fixture);

  const telemetry: object[] = [];
  const okResult = replayProductionTrajectoryThroughGym(fixture, {
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(okResult.ok, true);
  assert.equal(okResult.subjectId, fixture.subjectId);
  assert.ok(
    telemetry.every((t) => (t as { subjectId?: unknown }).subjectId != null),
  );
  const blob = JSON.stringify(telemetry);
  assert.ok(!blob.includes("typed-secret"));
  assert.ok(!blob.includes("consider ratio parts"));

  for (const frame of okResult.frames ?? []) {
    if (frame && typeof frame === "object" && "subjectId" in frame) {
      assert.equal(
        (frame as { subjectId: string }).subjectId,
        fixture.subjectId,
      );
    }
  }

  const missing = replayProductionTrajectoryThroughGym({
    ...fixture,
    subjectId: "",
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.failureClass, "missing_subject");
  log({
    outcome: "rejected",
    case: "missing-subject",
    subjectId: null,
    failureClass: "missing_subject",
  });
});

test("sovereignty: concurrent domain replays do not cross subjectId", async () => {
  const corpus = loadProductionTrajectoryParityCorpus({
    deviceId: "dev-parity-concurrent",
  });
  assert.equal(corpus.ok, true);
  assert.ok(corpus.entries.length >= 2);

  const a = corpus.entries[0]!;
  const b = corpus.entries[1]!;

  const [ra, rb] = await Promise.all([
    replayParityCorpusEntryThroughGymEnv(a, { seed: 3 }),
    replayParityCorpusEntryThroughGymEnv(b, { seed: 5 }),
  ]);
  assert.equal(ra.ok, true, ra.detail ?? "");
  assert.equal(rb.ok, true, rb.detail ?? "");

  for (const frame of ra.frames) {
    if (frame && typeof frame === "object" && "subjectId" in frame) {
      assert.equal(
        (frame as { subjectId: string }).subjectId,
        a.subjectId,
      );
    }
  }
  for (const frame of rb.frames) {
    if (frame && typeof frame === "object" && "subjectId" in frame) {
      assert.equal(
        (frame as { subjectId: string }).subjectId,
        b.subjectId,
      );
    }
  }

  // Distinct trajectories must not share canonical bytes when fixtures differ.
  if (a.id !== b.id) {
    assert.notEqual(ra.canonicalJson, rb.canonicalJson);
  }
  log({
    outcome: "ok",
    case: "concurrent-subject-isolation",
    subjectId: a.subjectId,
    turnId: `${a.id},${b.id}`,
  });
});

test("scalability: frame and corpus compare bounds are finite", () => {
  assert.ok(GYM_FRAME_COMPARE_LIMIT > 0);
  assert.ok(GYM_FRAME_COMPARE_LIMIT <= 2048);
  assert.ok(GYM_REPLAY_CORPUS_LIMIT > 0);
  assert.ok(GYM_REPLAY_CORPUS_LIMIT <= 256);
  assert.ok(PARITY_CORPUS_DOMAINS.length > 0);
  assert.ok(PARITY_CORPUS_DOMAINS.length <= 16);

  const over = Array.from({ length: GYM_FRAME_COMPARE_LIMIT + 1 }, (_, i) => ({
    sequenceIndex: i,
    type: "ANSWER_DELTA",
    delta: "x",
    subjectId: "s",
    correlationId: "c",
  }));
  const identity = assertFrameSequenceIdentity(over, over);
  assert.equal(identity.ok, false);
  assert.equal(identity.failingFrameType, "(section_limit)");
});

test("edge: unifiedDiff surfaces when canonical bytes diverge", () => {
  const expected = [{ sequenceIndex: 0, type: "TURN_COMPLETE", turnId: "t1" }];
  const actual = [{ sequenceIndex: 0, type: "TURN_COMPLETE", turnId: "t2" }];
  const diff = unifiedDiff(
    canonicalizeFramesJson(expected),
    canonicalizeFramesJson(actual),
    { fromFile: "expected", toFile: "actual" },
  );
  assert.ok(diff.length > 0);
  assert.match(diff, /t1|t2/);
});

function extractCiJobBlock(yml: string, jobId: string): string {
  const header = `  ${jobId}:\n`;
  const start = yml.indexOf(header);
  assert.ok(start >= 0, `missing CI job: ${jobId}`);
  const fromJob = yml.slice(start);
  const next = fromJob.slice(header.length).search(/\n  [a-z0-9-]+:\n/);
  return next === -1
    ? fromJob
    : fromJob.slice(0, header.length + next);
}

test("happy path: root CI wires path-filtered gym-replay-parity job", () => {
  const yml = readFileSync(CI_YML, "utf8").replace(/\r\n/g, "\n");
  assert.match(yml, /^  protocol-conformance:/m);
  const block = extractCiJobBlock(yml, "protocol-conformance");
  assert.match(block, /Replay parity gate \(first divergent frameIndex on fail\)/);
  assert.match(block, /detect-parity-ci-paths\.mjs/);
  assert.match(block, /training\/gym\//);
  assert.match(block, /packages\/runtime-harness\//);
  assert.match(block, /@moolam\/training-gym run ci:parity/);
  assert.match(block, /first divergent frameIndex|firstDivergentFrameIndex/i);
  assert.match(block, /replay_parity\.test\.ts/);
  assert.match(block, /upload-artifact@v4/);
  assert.match(block, /artifacts\/gym-replay-parity\//);
  assert.match(block, /fetch-depth:\s*0/);

  // Path filter must gate the heavy steps.
  assert.match(block, /parity_paths\.outputs\.run == 'true'/);
  assert.match(block, /parity_paths\.outputs\.run != 'true'/);

  const pkg = JSON.parse(readFileSync(PKG_JSON, "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.equal(typeof pkg.scripts["ci:parity"], "string");
  assert.match(pkg.scripts["ci:parity"], /parity:check/);
  assert.match(pkg.scripts["parity:check"], /check-replay-parity\.mjs/);

  // typescript job must not own the dedicated parity gate anymore.
  const tsBlock = extractCiJobBlock(yml, "build-test-typescript");
  assert.doesNotMatch(tsBlock, /parity:check|ci:parity/);
  log({ outcome: "ok", case: "ci-job-wired", subjectId: null });
});

test("edge: path filter triggers only gym / harness / ci.yml changes", () => {
  assert.ok(
    GYM_REPLAY_PARITY_PATH_PREFIXES.includes("training/gym/"),
  );
  assert.ok(
    GYM_REPLAY_PARITY_PATH_PREFIXES.includes("packages/runtime-harness/"),
  );

  assert.equal(pathTriggersGymReplayParity("training/gym/env.ts"), true);
  assert.equal(
    pathTriggersGymReplayParity("packages/runtime-harness/src/index.ts"),
    true,
  );
  assert.equal(
    pathTriggersGymReplayParity(".github/workflows/ci.yml"),
    true,
  );
  assert.equal(pathTriggersGymReplayParity("docs/README.md"), false);
  assert.equal(pathTriggersGymReplayParity("packages/learning/src/index.ts"), false);

  const matched = selectParityTriggeringPaths([
    "docs/README.md",
    "training/gym/tests/replay_parity.test.ts",
    "packages/edge-agent/src/cognitive_bindings.ts",
  ]);
  assert.deepEqual(matched, ["training/gym/tests/replay_parity.test.ts"]);

  const skipped = decideGymReplayParityRun({
    eventName: "pull_request",
    files: ["README.md", "packages/telemetry/src/collector.ts"],
  });
  assert.equal(skipped.run, false);

  const triggered = decideGymReplayParityRun({
    eventName: "pull_request",
    files: ["packages/runtime-harness/fixtures/golden-turns/manifest.json"],
  });
  assert.equal(triggered.run, true);

  const pushAlways = decideGymReplayParityRun({
    eventName: "push",
    files: ["README.md"],
  });
  assert.equal(pushAlways.run, true);
  log({ outcome: "ok", case: "path-filter", subjectId: null });
});

test("edge: parity gate failure surfaces first divergent frameIndex", () => {
  const loaded = loadGoldenTurnCorpus();
  assert.equal(loaded.ok, true);
  const fixture = loaded.fixtures[0];
  assert.ok(fixture);

  const result = replayProductionTrajectoryThroughGym(fixture);
  assert.equal(result.ok, true);

  const drifted = structuredClone(result.frames);
  assert.ok(drifted.length > 1);
  const target = drifted[1] as Record<string, unknown>;
  if (typeof target.delta === "string") {
    target.delta = `${target.delta}__CI_DRIFT__`;
  } else {
    target.type = "ANSWER_DELTA";
  }

  const byteCheck = assertByteIdenticalCanonicalFrames(
    fixture.expectedFrames,
    drifted,
    { turnId: fixture.id },
  );
  assert.equal(byteCheck.ok, false);
  assert.ok(
    byteCheck.failingFrameIndex >= 0,
    "CI must report first divergent frame index",
  );
  assert.ok(typeof byteCheck.failingFrameType === "string");
  assert.ok(byteCheck.diff.length > 0);

  // Script contract: stderr message names firstDivergentFrameIndex.
  const script = readFileSync(
    join(GYM_ROOT, "scripts/check-replay-parity.mjs"),
    "utf8",
  );
  assert.match(script, /firstDivergentFrameIndex/);
  assert.match(script, /blocks merge/);
  assert.match(script, /frameIndex/);
  log({
    outcome: "rejected",
    case: "ci-first-frame-index",
    subjectId: fixture.subjectId,
    frameIndex: byteCheck.failingFrameIndex,
    frameType: byteCheck.failingFrameType,
    failureClass: "canonical_drift",
  });
});

test("happy path: parity fixture regeneration runbook is coherent", () => {
  const telemetry: object[] = [];
  const loaded = loadParityFixtureRunbook({
    deviceId: "dev-runbook-unit",
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(loaded.ok, true, loaded.detail);
  assert.ok(loaded.text.includes("Never auto-accept"));
  assert.ok(loaded.text.includes("human review"));

  const coherent = assertParityFixtureRunbookCoherence({
    deviceId: "dev-runbook-unit",
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(coherent.ok, true, coherent.detail);

  const charter = readFileSync(CHARTER_PATH, "utf8");
  assert.match(charter, /parity-fixture-regeneration\.md/);
  assert.ok(charter.includes("Never auto-update"));

  assert.equal(
    PARITY_FIXTURE_RUNBOOK_RELPATH,
    "training/gym/docs/parity-fixture-regeneration.md",
  );
  assert.ok(
    telemetry.every(
      (t) => (t as { event?: string }).event === "training.gym.replay_parity",
    ),
  );
  assert.ok(!JSON.stringify(telemetry).includes("consider ratio parts"));
  log({
    outcome: "ok",
    case: "runbook-coherent",
    subjectId: null,
    path: PARITY_FIXTURE_RUNBOOK_RELPATH,
  });
});

test("edge: runbook forbids CI auto-accept and requires accidental-drift path", () => {
  const loaded = loadParityFixtureRunbook({ deviceId: "dev-runbook-edge" });
  assert.equal(loaded.ok, true);
  assert.match(loaded.text, /Workflow B/i);
  assert.match(loaded.text, /do \*\*not\*\* regenerate|do not regenerate/i);
  assert.match(loaded.text, /firstDivergentFrameIndex/);
  assert.doesNotMatch(
    loaded.text,
    /CI will auto-update|silently update fixtures/i,
  );

  // golden:write is documented as human-reviewed, not a CI step.
  assert.match(loaded.text, /golden:write/);
  assert.match(loaded.text, /human review before commit/i);

  // Compile script must not git commit (locked via coherence helper).
  const compile = readFileSync(
    join(GYM_ROOT, "scripts/compile-golden-scenarios.mjs"),
    "utf8",
  );
  assert.doesNotMatch(compile, /\bgit\s+commit\b/);
  assert.match(compile, /human review before commit/i);
  log({
    outcome: "ok",
    case: "runbook-no-auto-accept",
    subjectId: null,
  });
});

test("sovereignty: runbook keeps subjectId and forbids utterance dumps", () => {
  const loaded = loadParityFixtureRunbook({ deviceId: "dev-runbook-sov" });
  assert.equal(loaded.ok, true);
  assert.match(loaded.text, /subjectId/);
  assert.match(loaded.text, /Never paste raw learner|never paste raw learner/i);
  assert.match(loaded.text, /cross-subject/i);
  assert.ok(!loaded.text.includes("LEARNER_UTTERANCE_MUST_NOT_LEAK"));
  log({
    outcome: "ok",
    case: "runbook-sovereignty",
    subjectId: null,
  });
});
