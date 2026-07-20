/**
 * Unit coverage for field-pilot findings → freeze RFC packaging gate.
 * Run: node --test scripts/check-field-pilot-findings.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  OBLIGATIONS,
  REQUIRED_FINDING_PATTERNS,
  checkFieldPilotFindings,
} from "./check-field-pilot-findings.mjs";

test("happy path: committed findings + summary + RFC draft pass", () => {
  const result = checkFieldPilotFindings();
  assert.equal(result.ok, true, result.failures.join("\n"));
  assert.ok(result.files.length >= 3);
  assert.ok(REQUIRED_FINDING_PATTERNS.length >= 5);
});

test("edge: finding without severity / repro fails FINDING_FIELDS", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-pilot-find-"));
  const findings = path.join(dir, "findings");
  mkdirSync(findings);
  try {
    writeFileSync(
      path.join(findings, "2026-07-16-stub.md"),
      [
        "# stub",
        "subjectId: s1",
        "deviceId: d1",
        "sync gap synced=0 offline",
        "stt classroom noise Indic",
        "guidance routeAction routing",
        "behavioral metadata never raw keystroke",
        "trajectoryExport: false",
        // omit Severity / Repro / Affected spec / FP-id
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      path.join(dir, "PILOT-SUMMARY.md"),
      [
        "FP-001 FP-002 FP-003 FP-004",
        "P7-FREEZE-RFC-DRAFT.md",
        "PILOT-EXIT-REVIEW.md",
        "trajectoryExport false",
        "subjectId",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      path.join(dir, "P7-FREEZE-RFC-DRAFT.md"),
      "PILOT-SUMMARY.md findings/ FP-002 P1 open\n",
      "utf8",
    );
    const result = checkFieldPilotFindings({
      findingsDir: findings,
      summaryPath: path.join(dir, "PILOT-SUMMARY.md"),
      rfcDraftPath: path.join(dir, "P7-FREEZE-RFC-DRAFT.md"),
    });
    assert.equal(result.ok, false);
    assert.ok(
      result.failures.some((f) => f.includes(OBLIGATIONS.FINDING_FIELDS)),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edge: RFC draft without PILOT-SUMMARY link fails", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-pilot-rfc-"));
  const findings = path.join(dir, "findings");
  mkdirSync(findings);
  try {
    writeFileSync(
      path.join(findings, "2026-07-16-full.md"),
      [
        "# full",
        "| **Finding ID** | `FP-001` |",
        "| **Severity** | `P2` |",
        "| **Affected spec** | `CAST-01` |",
        "subjectId deviceId",
        "## Repro",
        "1. step",
        "sync gap synced=0 offline",
        "stt classroom noise Indic",
        "guidance routeAction routing",
        "behavioral metadata never raw keystroke",
        "trajectoryExport: false",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      path.join(dir, "PILOT-SUMMARY.md"),
      "FP-001 FP-002 FP-003 FP-004 P7-FREEZE-RFC-DRAFT.md PILOT-EXIT-REVIEW.md trajectoryExport false subjectId\n",
      "utf8",
    );
    writeFileSync(
      path.join(dir, "P7-FREEZE-RFC-DRAFT.md"),
      "FP-002 P1 findings/ but no summary link\n",
      "utf8",
    );
    const result = checkFieldPilotFindings({
      findingsDir: findings,
      summaryPath: path.join(dir, "PILOT-SUMMARY.md"),
      rfcDraftPath: path.join(dir, "P7-FREEZE-RFC-DRAFT.md"),
    });
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((f) => f.includes(OBLIGATIONS.RFC_LINK)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sovereignty: trajectoryExport true in finding fails", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-pilot-traj-"));
  const findings = path.join(dir, "findings");
  mkdirSync(findings);
  try {
    writeFileSync(
      path.join(findings, "2026-07-16-bad.md"),
      [
        "# bad",
        "Finding ID FP-099",
        "Severity P1",
        "Affected spec CK-05",
        "subjectId deviceId",
        "## Repro",
        "1. leak",
        "sync gap offline",
        "stt Indic",
        "routing guidance",
        "behavioral metadata never raw keystroke",
        "trajectoryExport: true",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      path.join(dir, "PILOT-SUMMARY.md"),
      "FP-001 FP-002 FP-003 FP-004 P7-FREEZE-RFC-DRAFT.md PILOT-EXIT-REVIEW.md trajectoryExport false subjectId\n",
      "utf8",
    );
    writeFileSync(
      path.join(dir, "P7-FREEZE-RFC-DRAFT.md"),
      "PILOT-SUMMARY.md findings/ FP-002 P1\n",
      "utf8",
    );
    const result = checkFieldPilotFindings({
      findingsDir: findings,
      summaryPath: path.join(dir, "PILOT-SUMMARY.md"),
      rfcDraftPath: path.join(dir, "P7-FREEZE-RFC-DRAFT.md"),
    });
    assert.equal(result.ok, false);
    assert.ok(
      result.failures.some(
        (f) =>
          f.includes(OBLIGATIONS.TRAJECTORY) ||
          f.includes("trajectory"),
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
