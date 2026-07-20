/**
 * Release tag rehearsal (B9 LAUNARTI-003) — P5 dry-run post P7 freeze.
 * Run: node --test scripts/release-tag-rehearsal.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OBLIGATIONS,
  RELEASE_RECORD_RELPATH,
  ReleaseTagRehearsalError,
  assertP7FreezeUnlocked,
  assertReleaseDocsLanded,
  assertReleaseWorkflowWiring,
  proveReleaseTagRehearsal,
  resetReleaseTagRehearsalState,
  runP5PublishPipelineDryRun,
  runReleaseTagRehearsal,
} from "./release-tag-rehearsal.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DEVICE_ID = "device.release-rehearsal.test";

test("happy path: docs + freeze + workflow + dry-run → signed record", () => {
  resetReleaseTagRehearsalState();
  const events = [];
  const result = runReleaseTagRehearsal({
    repoRoot: REPO_ROOT,
    deviceId: DEVICE_ID,
    subjectId: "system:release-rehearsal",
    operationId: "op.release.rehearsal.happy",
    write: true,
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(result.ok, true);
  assert.equal(result.freeze.unlocked, true);
  assert.equal(result.dryRun.ok, true);
  assert.ok(result.dryRun.packagesVerified >= 6);
  assert.equal(result.signed.ok, true);
  assert.equal(result.signed.idempotentReplay, false);
  assert.equal(result.signed.record.outcome, "signed");
  assert.equal(result.signed.record.checklist.p7FreezeUnlocked, true);
  assert.equal(result.signed.record.checklist.p5PublishDryRun, true);
  assert.ok(existsSync(path.join(REPO_ROOT, RELEASE_RECORD_RELPATH)));
  const disk = JSON.parse(
    readFileSync(path.join(REPO_ROOT, RELEASE_RECORD_RELPATH), "utf8"),
  );
  assert.equal(disk.version, "1.0.0");
  assert.equal(disk.attestors.length, 2);
  assert.ok(events.some((e) => e.action === "assert_docs" && e.outcome === "ok"));
  assert.ok(events.some((e) => e.action === "p5_dry_run" && e.outcome === "ok"));
  assert.ok(events.some((e) => e.action === "sign_record"));
  assert.ok(!JSON.stringify(events).includes("utterance"));
});

test("edge: freeze locked rejects before dry-run", () => {
  resetReleaseTagRehearsalState();
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-release-locked-"));
  try {
    mkdirSync(path.join(dir, "rfcs/appendix"), { recursive: true });
    writeFileSync(
      path.join(dir, "rfcs/0001-protocol-1.0-freeze.md"),
      "| **Status** | Draft |\n| **Maintainer acceptance** | Pending |\n",
      "utf8",
    );
    writeFileSync(
      path.join(dir, "rfcs/appendix/production-publish-gate.json"),
      JSON.stringify({ unlocked: false, reason: "draft" }),
      "utf8",
    );
    // Minimal docs + workflow so freeze is the failing step
    for (const rel of [
      "docs/releases/1.0.0.md",
      "docs/releases/MIGRATION-0.x.md",
      "docs/releases/ANNOUNCEMENT.md",
    ]) {
      mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    }
    writeFileSync(
      path.join(dir, "docs/releases/1.0.0.md"),
      "cross-track launch checklist\nProtocol 1.0 freeze\nrelease.yml\n",
      "utf8",
    );
    writeFileSync(
      path.join(dir, "docs/releases/MIGRATION-0.x.md"),
      "breaking changes\ncertification\npack formats\n",
      "utf8",
    );
    writeFileSync(
      path.join(dir, "docs/releases/ANNOUNCEMENT.md"),
      "CERTIFIED-BINDING\nA P5 publish pipeline\ncross-track\n",
      "utf8",
    );
    mkdirSync(path.join(dir, ".github/workflows"), { recursive: true });
    writeFileSync(
      path.join(dir, ".github/workflows/release.yml"),
      "Changeset publish dry-run\ncheck-production-publish-gate.mjs\n",
      "utf8",
    );

    assert.throws(
      () =>
        runReleaseTagRehearsal({
          repoRoot: dir,
          deviceId: DEVICE_ID,
          operationId: "op.release.rehearsal.locked",
          write: false,
          dryRun: () => ({ ok: true, packagesVerified: 1 }),
        }),
      (err) =>
        err instanceof ReleaseTagRehearsalError &&
        err.failureClass === OBLIGATIONS.FREEZE_LOCKED,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edge: injected dry-run failure and missing docs", () => {
  resetReleaseTagRehearsalState();
  assert.throws(
    () =>
      runReleaseTagRehearsal({
        repoRoot: REPO_ROOT,
        deviceId: DEVICE_ID,
        operationId: "op.release.rehearsal.dryfail",
        write: false,
        dryRun: () => ({ ok: false, detail: "pack dry-run failed" }),
      }),
    (err) =>
      err instanceof ReleaseTagRehearsalError &&
      err.failureClass === OBLIGATIONS.DRY_RUN_FAILED,
  );

  const empty = mkdtempSync(path.join(tmpdir(), "sutra-release-nodocs-"));
  try {
    assert.throws(
      () => assertReleaseDocsLanded({ repoRoot: empty }),
      (err) =>
        err instanceof ReleaseTagRehearsalError &&
        err.failureClass === OBLIGATIONS.MISSING_DOC,
    );
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("edge: sovereignty reject + idempotent replay", () => {
  resetReleaseTagRehearsalState();
  assert.throws(
    () =>
      runReleaseTagRehearsal({
        repoRoot: REPO_ROOT,
        deviceId: DEVICE_ID,
        operationId: "op.release.rehearsal.sov",
        write: false,
        utterance: "must never appear",
      }),
    (err) =>
      err instanceof ReleaseTagRehearsalError &&
      err.failureClass === OBLIGATIONS.SOVEREIGNTY,
  );

  const first = runReleaseTagRehearsal({
    repoRoot: REPO_ROOT,
    deviceId: DEVICE_ID,
    subjectId: "system:release-rehearsal",
    operationId: "op.release.rehearsal.replay",
    write: false,
  });
  const second = runReleaseTagRehearsal({
    repoRoot: REPO_ROOT,
    deviceId: DEVICE_ID,
    subjectId: "system:release-rehearsal",
    operationId: "op.release.rehearsal.replay",
    write: false,
  });
  assert.equal(first.signed.idempotentReplay, false);
  assert.equal(second.signed.idempotentReplay, true);
});

test("sovereignty: concurrent subjects keep isolated telemetry", async () => {
  resetReleaseTagRehearsalState();
  const a = [];
  const b = [];
  await Promise.all([
    Promise.resolve().then(() =>
      runReleaseTagRehearsal({
        repoRoot: REPO_ROOT,
        deviceId: "dev-a",
        subjectId: "system:release-a",
        operationId: "op.release.rehearsal.a",
        write: false,
        onTelemetry: (e) => a.push(e),
      }),
    ),
    Promise.resolve().then(() =>
      runReleaseTagRehearsal({
        repoRoot: REPO_ROOT,
        deviceId: "dev-b",
        subjectId: "system:release-b",
        operationId: "op.release.rehearsal.b",
        write: false,
        onTelemetry: (e) => b.push(e),
      }),
    ),
  ]);
  assert.ok(a.every((e) => e.subjectId === "system:release-a"));
  assert.ok(b.every((e) => e.subjectId === "system:release-b"));
  assert.ok(!JSON.stringify(a).includes("system:release-b"));
  assert.ok(!JSON.stringify(b).includes("system:release-a"));
});

test("unit: workflow + freeze + inventory helpers against repo", () => {
  assert.equal(assertReleaseDocsLanded({ repoRoot: REPO_ROOT }).ok, true);
  assert.equal(assertP7FreezeUnlocked({ repoRoot: REPO_ROOT }).unlocked, true);
  assert.equal(assertReleaseWorkflowWiring({ repoRoot: REPO_ROOT }).ok, true);
  const dry = runP5PublishPipelineDryRun({ repoRoot: REPO_ROOT });
  assert.equal(dry.ok, true);
  assert.ok(dry.packages.includes("sutra-sdk"));
});

test("prove: full proof green", () => {
  const proof = proveReleaseTagRehearsal({
    repoRoot: REPO_ROOT,
    deviceId: DEVICE_ID,
    write: true,
  });
  assert.equal(proof.ok, true);
  assert.equal(proof.happySigned, true);
  assert.equal(proof.idempotentReplay, true);
  assert.equal(proof.sovereigntyRejected, true);
});
