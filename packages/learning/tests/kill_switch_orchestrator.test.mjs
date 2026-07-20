/**
 * One-operation kill-switch orchestrator baseline reversion.
 * Run: node --test packages/learning/tests/kill_switch_orchestrator.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  KILL_SWITCH_LEARNED_FLAGS,
  KILL_SWITCH_POLICY_FLAGS,
  KillSwitchOrchestratorError,
  canonicalizeKillSwitchGoldenFrames,
  createKillSwitchOrchestratorStore,
  createLearnedOnKillSwitchSurface,
  isKillSwitchOrchestratorBaseline,
  resetKillSwitchOrchestratorReceipts,
  runKillSwitchGoldenRestorationDrill,
  runKillSwitchOrchestrator,
} from "../dist/kill_switch.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEVICE_ID = "device.kill-switch.orchestrator";
const CHAMPION = "adapter.champion.baseline";
const CHALLENGER = "adapter.challenger.learned";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DRILL_WORKFLOW = join(
  REPO_ROOT,
  ".github",
  "workflows",
  "kill-switch-drill.yml",
);
const RUNBOOK = join(REPO_ROOT, "docs", "learning", "KILL_SWITCH_RUNBOOK.md");
const CONSTITUTION = join(REPO_ROOT, "docs", "learning", "CONSTITUTION.md");

function learnedSurface(subjectId) {
  return createLearnedOnKillSwitchSurface({
    subjectId,
    deviceId: DEVICE_ID,
    locality: "on-device",
    championAdapterId: CHAMPION,
    challengerAdapterId: CHALLENGER,
  });
}

function assertScheduledDrillContract(workflow, runbook, constitution) {
  assert.match(workflow, /schedule:\s*\n\s*#.*\n\s*- cron: "0 6 1 \* \*"/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /timeout-minutes: 30/);
  assert.match(workflow, /group: scheduled-kill-switch-drill/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /issues: write/);
  assert.match(
    workflow,
    /node --test packages\/learning\/tests\/kill_switch_orchestrator\.test\.mjs/,
  );
  assert.match(
    workflow,
    /pnpm --filter @moolam\/runtime-harness golden:replay/,
  );
  assert.match(workflow, /if: \$\{\{ failure\(\) \}\}/);
  assert.match(workflow, /KILL_SWITCH_PAGER_WEBHOOK_URL/);
  assert.match(workflow, /curl --fail-with-body --retry 2 --max-time 15/);
  assert.match(workflow, /actions\/github-script@v7/);
  assert.match(workflow, /\[P0\] Scheduled kill-switch drill failed/);
  assert.doesNotMatch(
    workflow,
    /learnerContent|rawContent|promptBody|replyBody/,
  );

  assert.match(runbook, /Monthly — first day, 06:00 UTC/);
  assert.match(runbook, /Learning safety on-call/);
  assert.match(
    runbook,
    /gh workflow run kill-switch-drill\.yml --ref main/,
  );
  assert.match(runbook, /KILL_SWITCH_PAGER_WEBHOOK_URL/);
  assert.match(runbook, /do not cancel because the CI run was green/i);
  assert.match(
    constitution,
    /\[KILL_SWITCH_RUNBOOK\.md\]\(\.\/KILL_SWITCH_RUNBOOK\.md\)/,
  );
}

test("happy path: one operation unloads challenger + disables compaction/routing/healing", async () => {
  resetKillSwitchOrchestratorReceipts();
  const events = [];
  const surface = learnedSurface(null);
  assert.equal(isKillSwitchOrchestratorBaseline(surface), false);
  assert.equal(surface.flags.learned_compaction, true);
  assert.equal(surface.flags.learned_routing, true);
  assert.equal(surface.flags.learned_healing, true);

  const store = createKillSwitchOrchestratorStore([surface]);
  const result = await runKillSwitchOrchestrator({
    operationId: "op.ks.happy",
    store,
    subjectId: null,
    deviceId: DEVICE_ID,
    now: () => "2026-07-17T12:00:00.000Z",
    onTelemetry: (event) => events.push(event),
  });

  assert.equal(result.ok, true);
  assert.equal(result.idempotent, false);
  assert.equal(result.surface.activeAdapterId, CHAMPION);
  assert.equal(result.surface.adapterPinned, false);
  for (const flag of KILL_SWITCH_LEARNED_FLAGS) {
    assert.equal(result.surface.flags[flag], false, flag);
  }
  for (const flag of KILL_SWITCH_POLICY_FLAGS) {
    assert.equal(result.surface.flags[flag], false, flag);
  }
  assert.equal(isKillSwitchOrchestratorBaseline(result.surface), true);
  assert.equal(result.audit.adapterRevertedTo, CHAMPION);
  assert.equal(result.audit.outcome, "ok");
  assert.ok(result.audit.componentsReverted.includes("adapter"));
  assert.ok(events.some((event) => event.action === "unload_adapter"));
  assert.ok(events.some((event) => event.action === "audit"));
  assert.ok(!JSON.stringify(events).includes("utterance"));
});

test("edge: in-flight turn completes under pinned checkpoint before unload", async () => {
  resetKillSwitchOrchestratorReceipts();
  const subjectId = "subject.ks.inflight";
  let unloadedDuringDrain = false;
  const surface = createLearnedOnKillSwitchSurface({
    subjectId,
    deviceId: DEVICE_ID,
    locality: "on-device",
    championAdapterId: CHAMPION,
    challengerAdapterId: CHALLENGER,
    inFlightTurns: [
      {
        turnId: "turn.1",
        subjectId,
        pinnedCheckpointId: "ckpt.pinned.1",
        status: "running",
      },
    ],
  });
  const store = createKillSwitchOrchestratorStore([surface]);

  const result = await runKillSwitchOrchestrator({
    operationId: "op.ks.inflight",
    store,
    subjectId,
    deviceId: DEVICE_ID,
    now: () => "2026-07-17T12:01:00.000Z",
    drainTurn: async (turn) => {
      const live = store.get(subjectId);
      // Challenger must still be active while the turn drains.
      if (live?.activeAdapterId !== CHALLENGER) {
        unloadedDuringDrain = true;
      }
      assert.equal(turn.pinnedCheckpointId, "ckpt.pinned.1");
      assert.equal(turn.status, "running");
    },
  });

  assert.equal(unloadedDuringDrain, false);
  assert.equal(result.surface.activeAdapterId, CHAMPION);
  assert.deepEqual([...result.audit.drainedTurnIds], ["turn.1"]);
  assert.equal(
    result.surface.inFlightTurns[0]?.status,
    "completed_under_checkpoint",
  );
});

test("edge: idempotent second invoke is advisory no-op; partial + timeout named", async () => {
  resetKillSwitchOrchestratorReceipts();
  const store = createKillSwitchOrchestratorStore([learnedSurface(null)]);
  const first = await runKillSwitchOrchestrator({
    operationId: "op.ks.idem",
    store,
    subjectId: null,
    deviceId: DEVICE_ID,
    now: () => "2026-07-17T12:02:00.000Z",
  });
  assert.equal(first.idempotent, false);

  const second = await runKillSwitchOrchestrator({
    operationId: "op.ks.idem.2",
    store,
    subjectId: null,
    deviceId: DEVICE_ID,
    now: () => "2026-07-17T12:03:00.000Z",
  });
  assert.equal(second.idempotent, true);
  assert.equal(second.audit.outcome, "advisory_idempotent");
  assert.ok(second.audit.advisory?.includes("baseline"));

  resetKillSwitchOrchestratorReceipts();
  const partialStore = createKillSwitchOrchestratorStore([learnedSurface(null)]);
  await assert.rejects(
    runKillSwitchOrchestrator({
      operationId: "op.ks.partial",
      store: partialStore,
      subjectId: null,
      deviceId: DEVICE_ID,
      leaveOnFlags: ["learned_routing"],
    }),
    (error) => {
      assert.ok(error instanceof KillSwitchOrchestratorError);
      assert.equal(error.obligation, "kill_switch.partial");
      return true;
    },
  );

  resetKillSwitchOrchestratorReceipts();
  const hangSubject = "subject.ks.timeout";
  const hangSurface = createLearnedOnKillSwitchSurface({
    subjectId: hangSubject,
    deviceId: DEVICE_ID,
    locality: "on-device",
    championAdapterId: CHAMPION,
    challengerAdapterId: CHALLENGER,
    inFlightTurns: [
      {
        turnId: "turn.hang",
        subjectId: hangSubject,
        pinnedCheckpointId: "ckpt.hang",
        status: "running",
      },
    ],
  });
  const hangStore = createKillSwitchOrchestratorStore([hangSurface]);
  await assert.rejects(
    runKillSwitchOrchestrator({
      operationId: "op.ks.timeout",
      store: hangStore,
      subjectId: hangSubject,
      deviceId: DEVICE_ID,
      timeoutMs: 20,
      drainTurn: () => new Promise(() => {}),
    }),
    (error) => {
      assert.ok(error instanceof KillSwitchOrchestratorError);
      assert.equal(error.obligation, "kill_switch.downstream_timeout");
      return true;
    },
  );
});

test("sovereignty: cross-subject store isolation; empty subject rejected", async () => {
  resetKillSwitchOrchestratorReceipts();
  const a = learnedSurface("subject.ks.a");
  const b = learnedSurface("subject.ks.b");
  const store = createKillSwitchOrchestratorStore([a, b]);

  const ra = await runKillSwitchOrchestrator({
    operationId: "op.ks.a",
    store,
    subjectId: "subject.ks.a",
    deviceId: DEVICE_ID,
    now: () => "2026-07-17T12:04:00.000Z",
  });
  assert.equal(ra.surface.subjectId, "subject.ks.a");
  assert.equal(isKillSwitchOrchestratorBaseline(store.get("subject.ks.b")), false);
  assert.equal(isKillSwitchOrchestratorBaseline(store.get("subject.ks.a")), true);

  assert.throws(
    () =>
      createLearnedOnKillSwitchSurface({
        subjectId: "   ",
        deviceId: DEVICE_ID,
        locality: "on-device",
        championAdapterId: CHAMPION,
        challengerAdapterId: CHALLENGER,
      }),
    (error) => {
      assert.ok(error instanceof KillSwitchOrchestratorError);
      assert.equal(error.obligation, "kill_switch.missing_subject");
      return true;
    },
  );

  assert.throws(
    () =>
      createLearnedOnKillSwitchSurface({
        subjectId: "subject.ks.a",
        deviceId: DEVICE_ID,
        locality: "on-device",
        championAdapterId: CHAMPION,
        challengerAdapterId: CHALLENGER,
        inFlightTurns: [
          {
            turnId: "turn.x",
            subjectId: "subject.ks.other",
            pinnedCheckpointId: "ckpt.x",
            status: "running",
          },
        ],
      }),
    (error) => {
      assert.ok(error instanceof KillSwitchOrchestratorError);
      assert.equal(error.obligation, "kill_switch.cross_subject_denied");
      return true;
    },
  );
});

test("golden drill: learned-on → kill switch → all protocol turns byte-match", async () => {
  resetKillSwitchOrchestratorReceipts();
  const events = [];
  const surface = learnedSurface("anika-k");
  const store = createKillSwitchOrchestratorStore([surface]);

  const report = await runKillSwitchGoldenRestorationDrill({
    repoRoot: REPO_ROOT,
    operationId: "op.ks.golden",
    store,
    subjectId: "anika-k",
    deviceId: DEVICE_ID,
    now: () => "2026-07-17T12:05:00.000Z",
    executor: (fixture, baselineSurface) => {
      assert.equal(isKillSwitchOrchestratorBaseline(baselineSurface), true);
      assert.equal(baselineSurface.activeAdapterId, CHAMPION);
      return fixture.expectedFrames;
    },
    onTelemetry: (event) => events.push(event),
  });

  assert.equal(report.ok, true);
  assert.equal(report.byteMatch, true);
  assert.equal(report.goldenTurnCount, 5);
  assert.equal(report.proofs.length, 5);
  assert.ok(
    report.proofs.every(
      (proof) =>
        proof.byteMatch && proof.expectedHash === proof.actualHash,
    ),
  );
  assert.equal(report.killSwitchAudit.adapterRevertedTo, CHAMPION);
  assert.ok(
    events.some(
      (event) =>
        event.action === "golden_drill" &&
        event.goldenTurnCount === report.goldenTurnCount,
    ),
  );
  assert.ok(
    events
      .filter((event) => event.action === "golden_replay")
      .every(
        (event) =>
          typeof event.turnId === "string" &&
          event.expectedHash === event.actualHash,
      ),
  );
  assert.ok(!JSON.stringify(events).includes("consider ratio"));
});

test("golden drill: canonical drift blocks with hashes, never raw frames", async () => {
  resetKillSwitchOrchestratorReceipts();
  const events = [];
  const store = createKillSwitchOrchestratorStore([learnedSurface("anika-k")]);
  let replayCount = 0;

  await assert.rejects(
    runKillSwitchGoldenRestorationDrill({
      repoRoot: REPO_ROOT,
      operationId: "op.ks.golden.drift",
      store,
      subjectId: "anika-k",
      deviceId: DEVICE_ID,
      executor: (fixture) => {
        replayCount += 1;
        if (replayCount > 1) return fixture.expectedFrames;
        const drifted = structuredClone(fixture.expectedFrames);
        drifted[0] = { ...drifted[0], protocolVersion: "drifted" };
        return canonicalizeKillSwitchGoldenFrames(drifted);
      },
      onTelemetry: (event) => events.push(event),
    }),
    (error) => {
      assert.ok(error instanceof KillSwitchOrchestratorError);
      assert.equal(error.obligation, "kill_switch.golden_mismatch");
      return true;
    },
  );

  const mismatch = events.find(
    (event) => event.failureClass === "kill_switch.golden_mismatch",
  );
  assert.ok(mismatch);
  assert.notEqual(mismatch.expectedHash, mismatch.actualHash);
  assert.equal("frames" in mismatch, false);
  assert.equal("input" in mismatch, false);
});

test("golden drill: timeout typed; cross-subject fixture access denied", async () => {
  resetKillSwitchOrchestratorReceipts();
  const timeoutStore = createKillSwitchOrchestratorStore([
    learnedSurface("anika-k"),
  ]);
  await assert.rejects(
    runKillSwitchGoldenRestorationDrill({
      repoRoot: REPO_ROOT,
      operationId: "op.ks.golden.timeout",
      store: timeoutStore,
      subjectId: "anika-k",
      deviceId: DEVICE_ID,
      timeoutMs: 20,
      executor: () => new Promise(() => {}),
    }),
    (error) => {
      assert.ok(error instanceof KillSwitchOrchestratorError);
      assert.equal(error.obligation, "kill_switch.downstream_timeout");
      return true;
    },
  );

  resetKillSwitchOrchestratorReceipts();
  const otherStore = createKillSwitchOrchestratorStore([
    learnedSurface("subject.ks.other"),
  ]);
  await assert.rejects(
    runKillSwitchGoldenRestorationDrill({
      repoRoot: REPO_ROOT,
      operationId: "op.ks.golden.cross-subject",
      store: otherStore,
      subjectId: "subject.ks.other",
      deviceId: DEVICE_ID,
      executor: (fixture) => fixture.expectedFrames,
    }),
    (error) => {
      assert.ok(error instanceof KillSwitchOrchestratorError);
      assert.equal(error.obligation, "kill_switch.cross_subject_denied");
      return true;
    },
  );
});

test("scheduled drill: monthly CI, bounded paging, operator calendar, constitution link", () => {
  const workflow = readFileSync(DRILL_WORKFLOW, "utf8");
  const runbook = readFileSync(RUNBOOK, "utf8");
  const constitution = readFileSync(CONSTITUTION, "utf8");
  assertScheduledDrillContract(workflow, runbook, constitution);
});

test("scheduled drill: missing cron or pager fails schedule contract", () => {
  const workflow = readFileSync(DRILL_WORKFLOW, "utf8");
  const runbook = readFileSync(RUNBOOK, "utf8");
  const constitution = readFileSync(CONSTITUTION, "utf8");

  assert.throws(
    () =>
      assertScheduledDrillContract(
        workflow.replace('- cron: "0 6 1 * *"', '- cron: "0 6 1 1 *"'),
        runbook,
        constitution,
      ),
    assert.AssertionError,
  );
  assert.throws(
    () =>
      assertScheduledDrillContract(
        workflow.replaceAll("KILL_SWITCH_PAGER_WEBHOOK_URL", "PAGER_REMOVED"),
        runbook,
        constitution,
      ),
    assert.AssertionError,
  );
});
