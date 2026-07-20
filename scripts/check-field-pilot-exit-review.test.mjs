/**
 * Unit coverage for field pilot exit-review gate.
 * Run (after pnpm build): node --test scripts/check-field-pilot-exit-review.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  OBLIGATIONS,
  auditCollectorPrivacy,
  auditMarkSyncedLive,
  checkFieldPilotExitReview,
} from "./check-field-pilot-exit-review.mjs";

test("happy path: exit review + collector privacy + markSynced live", async () => {
  const result = await checkFieldPilotExitReview();
  assert.equal(result.ok, true, result.failures.join("\n"));
});

test("edge: collector with utterance column fails privacy audit", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-exit-col-"));
  const fake = path.join(dir, "collector.ts");
  try {
    writeFileSync(
      fake,
      [
        "charsDelta markSynced INSERT OR IGNORE",
        "hesitation_ms input_velocity revision_count",
        "NEVER leave the device behavioral metadata",
        "utterance_text TEXT", // forbidden
      ].join("\n"),
      "utf8",
    );
    const result = auditCollectorPrivacy({ collectorPath: fake });
    assert.equal(result.ok, false);
    assert.ok(
      result.failures.some((f) => f.includes(OBLIGATIONS.COLLECTOR_PRIVACY)),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edge: exit review missing FP-002 RFC blocker fails", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-exit-doc-"));
  const findings = path.join(dir, "findings");
  mkdirSync(findings);
  try {
    writeFileSync(
      path.join(dir, "PILOT-EXIT-REVIEW.md"),
      [
        "# stub",
        "Telemetry privacy sign-off no raw keystroke",
        "`markSynced` audit idempotent",
        "Routing quality sign-off Signed off",
        "Guidance eval gaps — all closed waived", // no FP-002 blocker
        "trajectoryExport false subjectId",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      path.join(findings, "2026-07-16-exit-review-signoff.md"),
      "FP-004 subjectId deviceId trajectoryExport: false\n",
      "utf8",
    );
    writeFileSync(
      path.join(dir, "PILOT-SUMMARY.md"),
      "PILOT-EXIT-REVIEW.md FP-004\n",
      "utf8",
    );
    writeFileSync(
      path.join(dir, "P7-FREEZE-RFC-DRAFT.md"),
      "FP-002 Open P1 blocker PILOT-EXIT-REVIEW\n",
      "utf8",
    );
    const result = await checkFieldPilotExitReview({
      exitReviewPath: path.join(dir, "PILOT-EXIT-REVIEW.md"),
      findingsDir: findings,
      summaryPath: path.join(dir, "PILOT-SUMMARY.md"),
      rfcDraftPath: path.join(dir, "P7-FREEZE-RFC-DRAFT.md"),
      skipLive: true,
    });
    assert.equal(result.ok, false);
    assert.ok(
      result.failures.some(
        (f) =>
          f.includes(OBLIGATIONS.GAP_RFC) || f.includes("FP-002"),
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sovereignty: live markSynced leaves zero unsynced after replay", async () => {
  const live = await auditMarkSyncedLive();
  assert.equal(live.ok, true, live.failures.join("\n"));
  assert.equal(live.unsyncedAfterReplay, 0);
});
