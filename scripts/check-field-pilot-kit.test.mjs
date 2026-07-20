/**
 * Unit coverage for the field pilot kit consistency gate.
 * Run: node --test scripts/check-field-pilot-kit.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  KIT_DOC,
  OBLIGATIONS,
  REQUIRED_KIT_PATTERNS,
  REQUIRED_REPO_PATHS,
  checkFieldPilotKit,
} from "./check-field-pilot-kit.mjs";

test("happy path: committed kit + README links pass", () => {
  const result = checkFieldPilotKit();
  assert.equal(result.ok, true, result.failures.join("\n"));
  assert.equal(result.failures.length, 0);
  assert.ok(REQUIRED_KIT_PATTERNS.length >= 8);
  assert.ok(REQUIRED_REPO_PATHS.length >= 5);
  assert.ok(KIT_DOC.includes("FIELD-PILOT-KIT.md"));
});

test("edge: missing kit doc fails with MISSING_KIT", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-pilot-kit-"));
  try {
    const result = checkFieldPilotKit({
      kitPath: path.join(dir, "missing.md"),
      offlineEdgeReadme: path.join(dir, "oe.md"),
      telemetryReadme: path.join(dir, "tel.md"),
    });
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((f) => f.includes(OBLIGATIONS.MISSING_KIT)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edge: kit without privacy / subject scope fails", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-pilot-kit-"));
  const kit = path.join(dir, "kit.md");
  const oe = path.join(dir, "oe.md");
  const tel = path.join(dir, "tel.md");
  try {
    writeFileSync(
      kit,
      [
        "# stub",
        "android-mid apple-silicon teacher-cbse-slice@1.0.0 onnx mlx",
        "offline-edge bindings-speech bindings-vision CAST-05.1",
        "Verified: 2026-07-16 Concurrent turns idempotent",
        "field-pilot.consent.v1 markSynced frictionSampleSync write-ahead unsynced",
        "Operator checklist What leaves the device Stays sovereign",
        'trajectoryExport: false',
        // deliberately omit keystroke / subjectId / deviceId
      ].join("\n"),
      "utf8",
    );
    writeFileSync(oe, "See FIELD-PILOT-KIT.md\n", "utf8");
    writeFileSync(
      tel,
      [
        "FIELD-PILOT-KIT.md markSynced consent write-ahead",
        "Raw keystroke content never leaves",
      ].join("\n"),
      "utf8",
    );
    const result = checkFieldPilotKit({
      kitPath: kit,
      offlineEdgeReadme: oe,
      telemetryReadme: tel,
      repoRoot: path.resolve(path.dirname(KIT_DOC), "..", ".."),
    });
    assert.equal(result.ok, false);
    assert.ok(
      result.failures.some(
        (f) =>
          f.includes(OBLIGATIONS.PRIVACY) ||
          f.includes(OBLIGATIONS.SUBJECT_SCOPE) ||
          f.includes("no-raw-keystroke") ||
          f.includes("subjectId"),
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edge: kit without consent / markSynced fails CONSENT", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-pilot-kit-"));
  const kit = path.join(dir, "kit.md");
  const oe = path.join(dir, "oe.md");
  const tel = path.join(dir, "tel.md");
  try {
    writeFileSync(
      kit,
      [
        "# stub",
        "android-mid apple-silicon teacher-cbse-slice@1.0.0 onnx mlx",
        "offline-edge bindings-speech bindings-vision CAST-05.1",
        "Verified: 2026-07-16 Concurrent turns idempotent",
        "never raw keystroke behavioral metadata",
        "subjectId deviceId",
        // omit consent.v1 / markSynced / frictionSampleSync
      ].join("\n"),
      "utf8",
    );
    writeFileSync(oe, "See FIELD-PILOT-KIT.md\n", "utf8");
    writeFileSync(
      tel,
      [
        "FIELD-PILOT-KIT.md markSynced consent write-ahead",
        "Raw keystroke content never leaves",
      ].join("\n"),
      "utf8",
    );
    const result = checkFieldPilotKit({
      kitPath: kit,
      offlineEdgeReadme: oe,
      telemetryReadme: tel,
      repoRoot: path.resolve(path.dirname(KIT_DOC), "..", ".."),
    });
    assert.equal(result.ok, false);
    assert.ok(
      result.failures.some(
        (f) =>
          f.includes(OBLIGATIONS.CONSENT) ||
          f.includes("consent-schema") ||
          f.includes("markSynced"),
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
