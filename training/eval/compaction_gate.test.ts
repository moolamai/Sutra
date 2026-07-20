/**
 * Full compaction eval-suite assembly from frozen B5 golden scenarios.
 * Run: node --experimental-strip-types --test training/eval/compaction_gate.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CompactionGateContractError,
  CompactionEvalContractError,
  assembleCompactionEvalSuite,
  computeCompactionEvalContentHash,
  computeCompactionEvalSuiteHash,
  runCompactionPromotionGate,
  type B5CompactionGoldenCase,
  type B5CompactionGoldenManifest,
  type CompactionCandidateEvaluator,
  type CompactionEvalScenario,
} from "../../packages/learning/src/compaction_promotion.ts";
import {
  B5_COMPACTION_CASES_HASH,
  B5_COMPACTION_GOLDEN_DIR,
  B5_COMPACTION_MANIFEST_HASH,
  COMPACTION_EVAL_PINNED_SEED,
  COMPACTION_EVAL_RUBRIC_ID,
  COMPACTION_EVAL_RUBRIC_VERSION,
  loadFullCompactionEvalSuite,
  proveFullCompactionGateCi,
  runFullCompactionPromotionGate,
} from "./compaction_gate.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function rawB5Source() {
  const dir = join(REPO_ROOT, B5_COMPACTION_GOLDEN_DIR);
  const manifestBytes = readFileSync(join(dir, "manifest.json"));
  const casesBytes = readFileSync(join(dir, "cases.json"));
  return {
    manifest: JSON.parse(
      manifestBytes.toString("utf8"),
    ) as B5CompactionGoldenManifest,
    cases: (
      JSON.parse(casesBytes.toString("utf8")) as {
        cases: B5CompactionGoldenCase[];
      }
    ).cases,
    manifestContentHash: computeCompactionEvalContentHash(manifestBytes),
    casesContentHash: computeCompactionEvalContentHash(casesBytes),
  };
}

function assembleWith(
  overrides: Partial<Parameters<typeof assembleCompactionEvalSuite>[0]> = {},
) {
  const source = rawB5Source();
  return assembleCompactionEvalSuite({
    ...source,
    expectedManifestContentHash: B5_COMPACTION_MANIFEST_HASH,
    expectedCasesContentHash: B5_COMPACTION_CASES_HASH,
    trainingCorpusContentHashes: [],
    pinnedSeed: COMPACTION_EVAL_PINNED_SEED,
    subjectId: "anika-k",
    deviceId: "ci",
    locality: "on-device",
    rubricId: COMPACTION_EVAL_RUBRIC_ID,
    rubricVersion: COMPACTION_EVAL_RUBRIC_VERSION,
    surgeryClasses: ["learned_compaction"],
    ...overrides,
  });
}

test("full suite contains every B5 golden plus replay and consent slices", () => {
  const events = [];
  const suite = loadFullCompactionEvalSuite({
    expectedSubjectId: "anika-k",
    deviceId: "dev.compaction.eval",
    locality: "on-device",
    trainingCorpusContentHashes: [],
    repoRoot: REPO_ROOT,
    onTelemetry: (event) => events.push(event),
  });
  const replay = loadFullCompactionEvalSuite({
    expectedSubjectId: "anika-k",
    deviceId: "dev.compaction.eval",
    locality: "on-device",
    trainingCorpusContentHashes: [],
    repoRoot: REPO_ROOT,
  });

  assert.deepEqual(replay, suite);
  assert.equal(suite.frozen, true);
  assert.equal(suite.heldOut, true);
  assert.equal(suite.excludeFromTrainingCorpora, true);
  assert.equal(suite.decontaminated, true);
  assert.equal(suite.source.manifestContentHash, B5_COMPACTION_MANIFEST_HASH);
  assert.equal(suite.source.casesContentHash, B5_COMPACTION_CASES_HASH);
  assert.equal(suite.scenarios.length, 6);
  assert.equal(
    new Set(suite.scenarios.map((scenario) => scenario.pinnedSeed)).size,
    suite.scenarios.length,
  );

  for (const requiredId of suite.source.requiredCaseIds) {
    assert.ok(
      suite.scenarios.some((scenario) => scenario.sourceCaseId === requiredId),
      `missing projected B5 scenario ${requiredId}`,
    );
  }
  const replayCases = suite.scenarios.filter(
    (scenario) => scenario.downstreamReplay.required,
  );
  assert.equal(replayCases.length, 3);
  assert.ok(
    replayCases.every(
      (scenario) =>
        scenario.downstreamReplay.historyMode === "summary_only" &&
        scenario.rubricThreshold.minimumTotal === 1,
    ),
  );
  const consent = suite.scenarios.find(
    (scenario) => scenario.sliceId === "compaction/sovereignty/consent-leak",
  );
  assert.ok(consent);
  assert.equal(consent.rubricThreshold.maximumTotal, -2);
  assert.equal(consent.rubricThreshold.requireHardFail, true);
  assert.equal(consent.rubricThreshold.consentChecksGreen, false);

  assert.ok(events.some((event) => event.outcome === "ok"));
  const telemetry = JSON.stringify(events);
  assert.ok(!telemetry.includes("ratio >= 2"));
  assert.ok(!telemetry.includes("secret-constraint"));
  const report = JSON.stringify(suite);
  assert.ok(!report.includes("water boils"));
  assert.ok(!report.includes("secret-constraint"));
});

test("frozen hash mismatch and train-on-eval collision fail with typed signals", () => {
  const events = [];
  assert.throws(
    () =>
      assembleWith({
        expectedCasesContentHash:
          "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        onTelemetry: (event) => events.push(event),
      }),
    (error) =>
      error instanceof CompactionEvalContractError &&
      error.obligation === "compaction_eval.source_hash_mismatch",
  );
  assert.ok(
    events.some(
      (event) =>
        event.failureClass === "compaction_eval.source_hash_mismatch",
    ),
  );

  assert.throws(
    () =>
      loadFullCompactionEvalSuite({
        expectedSubjectId: "anika-k",
        locality: "on-device",
        trainingCorpusContentHashes: [B5_COMPACTION_CASES_HASH],
        repoRoot: REPO_ROOT,
      }),
    (error) =>
      error instanceof CompactionEvalContractError &&
      error.obligation === "compaction_eval.train_on_eval_void",
  );
});

test("subject scope, complete source, locality, and one-surgery rules are enforced", () => {
  assert.throws(
    () =>
      loadFullCompactionEvalSuite({
        expectedSubjectId: "other-subject",
        locality: "on-device",
        trainingCorpusContentHashes: [],
        repoRoot: REPO_ROOT,
      }),
    (error) =>
      error instanceof CompactionEvalContractError &&
      error.obligation === "compaction_eval.subject_scope" &&
      error.failingScenario === "retain-refusal-citation-numeric",
  );

  const source = rawB5Source();
  assert.throws(
    () =>
      assembleWith({
        manifest: {
          ...source.manifest,
          requiredCases: [...source.manifest.requiredCases, "missing-case"],
        },
      }),
    (error) =>
      error instanceof CompactionEvalContractError &&
      error.obligation === "compaction_eval.required_case_missing" &&
      error.failingScenario === "missing-case",
  );
  assert.throws(
    () =>
      assembleWith({
        surgeryClasses: ["learned_compaction", "routing"],
      }),
    (error) =>
      error instanceof CompactionEvalContractError &&
      error.obligation === "compaction_eval.attribution_void",
  );
  assert.throws(
    () =>
      assembleWith({ locality: "remote" as never }),
    (error) =>
      error instanceof CompactionEvalContractError &&
      error.obligation === "compaction_eval.locality_forbidden",
  );
});

function candidateEvaluator(input: {
  candidateId: string;
  uplift?: number;
  subjectId?: string;
  locality?: "on-device" | "self-hosted";
  override?: (
    scenario: CompactionEvalScenario,
    observation: {
      scenarioId: string;
      subjectId: string;
      pinnedSeed: number;
      total: number;
      hardFail: boolean;
      harnessOutcome: "compacted" | "deferred" | "rejected";
      failureClass: string | null;
      downstreamReplaySuccess: boolean;
    },
  ) => typeof observation;
}): CompactionCandidateEvaluator {
  const subjectId = input.subjectId ?? "anika-k";
  return {
    candidateId: input.candidateId,
    subjectId,
    locality: input.locality ?? "on-device",
    evaluate(scenario) {
      const threshold = scenario.rubricThreshold;
      const total =
        threshold.minimumTotal !== null
          ? threshold.minimumTotal + (input.uplift ?? 0)
          : threshold.maximumTotal!;
      const observation = {
        scenarioId: scenario.scenarioId,
        subjectId,
        pinnedSeed: scenario.pinnedSeed,
        total,
        hardFail: threshold.requireHardFail,
        harnessOutcome: scenario.expectedHarnessOutcome,
        failureClass: scenario.expectedFailureClass,
        downstreamReplaySuccess: scenario.downstreamReplay.required,
      };
      return input.override?.(scenario, observation) ?? observation;
    },
  };
}

test("promotion runner promotes a strict full-suite improvement", async () => {
  const events = [];
  const verdict = await runFullCompactionPromotionGate({
    expectedSubjectId: "anika-k",
    deviceId: "dev.compaction.gate",
    locality: "on-device",
    trainingCorpusContentHashes: [],
    repoRoot: REPO_ROOT,
    champion: candidateEvaluator({ candidateId: "deterministic-b5" }),
    challenger: candidateEvaluator({
      candidateId: "learned-known-good",
      uplift: 1,
    }),
    onTelemetry: (event) => events.push(event),
  });

  assert.equal(verdict.verdict, "promote");
  assert.equal(verdict.promoted, true);
  assert.ok(verdict.aggregateDelta > 0);
  assert.deepEqual(verdict.failingScenarioIds, []);
  assert.equal(verdict.scenarios.length, 6);
  const replay = await runFullCompactionPromotionGate({
    expectedSubjectId: "anika-k",
    deviceId: "dev.compaction.gate",
    locality: "on-device",
    trainingCorpusContentHashes: [],
    repoRoot: REPO_ROOT,
    champion: candidateEvaluator({ candidateId: "deterministic-b5" }),
    challenger: candidateEvaluator({
      candidateId: "learned-known-good",
      uplift: 1,
    }),
  });
  assert.deepEqual(replay, verdict);
  assert.ok(
    events.some(
      (event) =>
        event.event === "learning.compaction_gate.verdict" &&
        event.outcome === "ok",
    ),
  );
  const wire = JSON.stringify(events);
  assert.ok(!wire.includes("ratio >= 2"));
  assert.ok(!wire.includes("secret-constraint"));
});

test("regression, consent failure, and tie reject with scenario ids", async () => {
  const target = "b5.second-pass-episodic-drop";
  const regressed = await runFullCompactionPromotionGate({
    expectedSubjectId: "anika-k",
    locality: "on-device",
    trainingCorpusContentHashes: [],
    repoRoot: REPO_ROOT,
    champion: candidateEvaluator({ candidateId: "deterministic-b5" }),
    challenger: candidateEvaluator({
      candidateId: "learned-regressed",
      uplift: 1,
      override: (scenario, observation) =>
        scenario.scenarioId === target
          ? { ...observation, total: 0 }
          : observation,
    }),
  });
  assert.equal(regressed.verdict, "reject");
  assert.equal(regressed.reason, "challenger_threshold_failed");
  assert.deepEqual(regressed.failingScenarioIds, [target]);

  const consentId = "synthetic.consent-leak-hard-fail";
  const consentFailed = await runFullCompactionPromotionGate({
    expectedSubjectId: "anika-k",
    locality: "on-device",
    trainingCorpusContentHashes: [],
    repoRoot: REPO_ROOT,
    champion: candidateEvaluator({ candidateId: "deterministic-b5" }),
    challenger: candidateEvaluator({
      candidateId: "learned-consent-leak",
      uplift: 1,
      override: (scenario, observation) =>
        scenario.scenarioId === consentId
          ? { ...observation, total: 0, hardFail: false }
          : observation,
    }),
  });
  assert.equal(consentFailed.verdict, "reject");
  assert.equal(consentFailed.reason, "consent_failed");
  assert.deepEqual(consentFailed.failingScenarioIds, [consentId]);

  const tie = await runFullCompactionPromotionGate({
    expectedSubjectId: "anika-k",
    locality: "on-device",
    trainingCorpusContentHashes: [],
    repoRoot: REPO_ROOT,
    champion: candidateEvaluator({ candidateId: "deterministic-b5" }),
    challenger: candidateEvaluator({ candidateId: "learned-tie" }),
  });
  assert.equal(tie.verdict, "reject");
  assert.equal(tie.reason, "tie");
  assert.equal(tie.failingScenarioIds.length, 6);
});

test("runner rejects cross-subject evidence and surfaces downstream timeout", async () => {
  const events = [];
  await assert.rejects(
    () =>
      runFullCompactionPromotionGate({
        expectedSubjectId: "anika-k",
        locality: "on-device",
        trainingCorpusContentHashes: [],
        repoRoot: REPO_ROOT,
        champion: candidateEvaluator({ candidateId: "deterministic-b5" }),
        challenger: candidateEvaluator({
          candidateId: "cross-subject",
          subjectId: "other-subject",
        }),
        onTelemetry: (event) => events.push(event),
      }),
    (error) =>
      error instanceof CompactionGateContractError &&
      error.obligation === "compaction_gate.subject_scope",
  );
  assert.ok(
    events.some(
      (event) =>
        event.event === "learning.compaction_gate.verdict" &&
        event.failureClass === "compaction_gate.subject_scope",
    ),
  );

  const suite = loadFullCompactionEvalSuite({
    expectedSubjectId: "anika-k",
    locality: "on-device",
    trainingCorpusContentHashes: [],
    repoRoot: REPO_ROOT,
  });
  const firstId = suite.scenarios[0]!.scenarioId;
  const fastTimeoutSuite = {
    ...suite,
    scenarios: suite.scenarios.map((scenario, index) =>
      index === 0
        ? {
            ...scenario,
            downstreamReplay: {
              ...scenario.downstreamReplay,
              timeoutMs: 10,
            },
          }
        : scenario,
    ),
  };
  fastTimeoutSuite.suiteContentHash =
    computeCompactionEvalSuiteHash(fastTimeoutSuite);
  const neverCompletes = candidateEvaluator({
    candidateId: "deterministic-timeout",
  });
  neverCompletes.evaluate = () => new Promise(() => {});

  await assert.rejects(
    () =>
      runCompactionPromotionGate({
        suite: fastTimeoutSuite,
        champion: neverCompletes,
        challenger: candidateEvaluator({ candidateId: "learned-known-good" }),
        deviceId: "ci",
      }),
    (error) =>
      error instanceof CompactionGateContractError &&
      error.obligation === "compaction_gate.downstream_timeout" &&
      error.failingScenario === firstId,
  );
});

test("CI prove: flag-off parity green; seeded promote; tie and regression reject", async () => {
  const events = [];
  const proved = await proveFullCompactionGateCi({
    expectedSubjectId: "anika-k",
    locality: "on-device",
    trainingCorpusContentHashes: [],
    deviceId: "ci-compaction-gate",
    repoRoot: REPO_ROOT,
    onTelemetry: (event) => events.push(event),
  });

  assert.equal(proved.ok, true);
  assert.equal(proved.replayOk, true);
  assert.equal(proved.flagOffParity.verdict, "reject");
  assert.equal(proved.flagOffParity.reason, "tie");
  assert.equal(proved.flagOffParity.aggregateDelta, 0);
  assert.equal(proved.seededPromote.verdict, "promote");
  assert.ok(proved.seededPromote.aggregateDelta > 0);
  assert.equal(proved.tieReject.reason, "tie");
  assert.equal(proved.regressionReject.reason, "challenger_threshold_failed");
  assert.ok(proved.regressionReject.failingScenarioIds.length >= 1);

  const replay = await proveFullCompactionGateCi({
    expectedSubjectId: "anika-k",
    locality: "on-device",
    trainingCorpusContentHashes: [],
    deviceId: "ci-compaction-gate",
    repoRoot: REPO_ROOT,
  });
  assert.equal(replay.seededPromote.aggregateDelta, proved.seededPromote.aggregateDelta);
  assert.deepEqual(
    replay.regressionReject.failingScenarioIds,
    proved.regressionReject.failingScenarioIds,
  );

  assert.ok(
    events.some(
      (event) =>
        event.event === "learning.compaction_gate.ci" && event.outcome === "ok",
    ),
  );
  const wire = JSON.stringify(events);
  assert.ok(!wire.includes("ratio >= 2"));
  assert.ok(!wire.includes("secret-constraint"));
  assert.ok(!wire.includes("water boils"));
});
