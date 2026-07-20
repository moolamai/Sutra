/**
 * Kill-switch runbook coherence + apply semantics (constitution L4).
 * Run: pnpm --filter @moolam/learning test
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  KILL_SWITCH_DRILL_INTERVAL_DAYS,
  KILL_SWITCH_LEARNED_FLAGS,
  KILL_SWITCH_RUNBOOK_RELPATH,
  applyKillSwitch,
  assertKillSwitchRunbookCoherent,
  createLearnedOnState,
  isKillSwitchBaseline,
  loadKillSwitchRunbook,
} from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

function log(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "learning.governance.kill_switch.test", ...event })}\n`,
  );
}

test("happy path: runbook present, coherent, links verify + drill schedule", async () => {
  const telemetry = [];
  const loaded = await loadKillSwitchRunbook({
    repoRoot: REPO_ROOT,
    subjectId: null,
    deviceId: "dev-ks-doc",
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(loaded.ok, true, loaded.detail);
  assert.equal(loaded.relpath, KILL_SWITCH_RUNBOOK_RELPATH);

  const coherent = assertKillSwitchRunbookCoherent(loaded.text, {
    subjectId: null,
    deviceId: "dev-ks-doc",
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(coherent.ok, true, coherent.detail);

  assert.ok(loaded.text.includes("parity:check"));
  assert.ok(loaded.text.includes("golden:replay"));
  assert.ok(loaded.text.includes("Monthly"));
  assert.equal(KILL_SWITCH_DRILL_INTERVAL_DAYS, 30);
  for (const flag of KILL_SWITCH_LEARNED_FLAGS) {
    assert.ok(loaded.text.includes(flag), flag);
  }
  assert.ok(
    telemetry.some(
      (t) => t.action === "assert_kill_switch_runbook" && t.outcome === "ok",
    ),
  );
  log({
    outcome: "ok",
    case: "runbook-coherent",
    subjectId: null,
    path: KILL_SWITCH_RUNBOOK_RELPATH,
  });
});

test("happy path: kill-switch reverts all learned flags in one apply", () => {
  const telemetry = [];
  const on = createLearnedOnState();
  assert.equal(isKillSwitchBaseline(on), false);

  const result = applyKillSwitch(on, {
    subjectId: null,
    deviceId: "dev-ks-apply",
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(result.ok, true);
  assert.equal(result.idempotent, false);
  assert.equal(isKillSwitchBaseline(result.state), true);
  assert.equal(result.state.adapterPinned, false);
  assert.ok(result.componentsReverted.includes("adapter"));
  assert.ok(
    telemetry.some((t) => t.action === "kill_switch" && t.outcome === "ok"),
  );
  assert.ok(!JSON.stringify(telemetry).includes("utterance"));
  log({
    outcome: "ok",
    case: "full-revert",
    subjectId: null,
    componentsReverted: result.componentsReverted,
  });
});

test("edge: partial revert fails kill_switch_partial (drill must not pass)", () => {
  const telemetry = [];
  const on = createLearnedOnState();
  const partial = applyKillSwitch(on, {
    subjectId: null,
    deviceId: "dev-ks-partial",
    leaveOnFlags: ["learned_routing"],
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(partial.ok, false);
  assert.equal(partial.failureClass, "kill_switch_partial");
  assert.ok(partial.remainingOn.includes("learned_routing"));
  assert.equal(isKillSwitchBaseline(partial.state), false);
  assert.ok(
    telemetry.some((t) => t.failureClass === "kill_switch_partial"),
  );
  log({
    outcome: "rejected",
    case: "partial",
    subjectId: null,
    failureClass: "kill_switch_partial",
    remainingOn: partial.remainingOn,
  });
});

test("edge: idempotent second apply stays baseline (no double-apply drift)", () => {
  const first = applyKillSwitch(createLearnedOnState(), {
    subjectId: null,
    deviceId: "dev-ks-idem",
  });
  assert.equal(first.ok, true);
  const second = applyKillSwitch(first.state, {
    subjectId: null,
    deviceId: "dev-ks-idem",
  });
  assert.equal(second.ok, true);
  assert.equal(second.idempotent, true);
  assert.equal(isKillSwitchBaseline(second.state), true);
  assert.deepEqual(second.state.flags, first.state.flags);
});

test("sovereignty: subject-bound apply carries subjectId; empty subject rejected", () => {
  const telemetry = [];
  const ok = applyKillSwitch(createLearnedOnState(), {
    subjectId: "subj-ks-a",
    deviceId: "dev-ks-subj",
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(ok.ok, true);
  assert.ok(
    telemetry.every((t) => t.subjectId === "subj-ks-a"),
  );

  const missing = applyKillSwitch(createLearnedOnState(), {
    subjectId: "   ",
    deviceId: "dev-ks-subj",
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.failureClass, "missing_subject");

  // Cross-subject: two applies must not share mutable mistaken scope
  const a = applyKillSwitch(createLearnedOnState(), { subjectId: "subj-a" });
  const b = applyKillSwitch(createLearnedOnState(), { subjectId: "subj-b" });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.notEqual(a.state, b.state);
  log({
    outcome: "ok",
    case: "subject-scope",
    subjectId: "subj-ks-a",
  });
});
