/**
 * B9 launch-artifacts: tag rehearsal via A P5 pipeline post P7 freeze.
 *
 * Flow: P5 publish-pipeline dry-run → verify packages + docs land → checklist
 * signed in release record. Cross-track launch checklist is local-only
 * (node scripts/launch-checklist.mjs); it is not a public CI gate.
 *
 * Usage (repo root):
 *   node scripts/release-tag-rehearsal.mjs
 *   node scripts/release-tag-rehearsal.mjs --write
 *   node scripts/release-tag-rehearsal.mjs --prove
 *   pnpm release:tag-rehearsal
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFreezeAcceptance } from "./check-production-publish-gate.mjs";
import { isPublishableNpmPackageName } from "./check-changeset-config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");

export const RELEASE_DOCS = Object.freeze([
  "docs/releases/1.0.0.md",
  "docs/releases/MIGRATION-0.x.md",
  "docs/releases/ANNOUNCEMENT.md",
]);

export const RELEASE_WORKFLOW_RELPATH = ".github/workflows/release.yml";
export const RELEASE_RECORD_RELPATH =
  "docs/releases/RELEASE-RECORD-1.0.0.json";
export const RELEASE_RECORD_SCHEMA = "release.tag-rehearsal.record.v1";

export const RELEASE_DOC_REQUIRED_PHRASES = Object.freeze({
  "docs/releases/1.0.0.md": [
    "cross-track launch checklist",
    "Protocol 1.0 freeze",
    "release.yml",
  ],
  "docs/releases/MIGRATION-0.x.md": ["breaking", "certif", "pack"],
  "docs/releases/ANNOUNCEMENT.md": [
    "CERTIFIED-BINDING",
    "A P5 publish pipeline",
    "cross-track",
  ],
});

export const WORKFLOW_REQUIRED_PHRASES = Object.freeze([
  "Changeset publish dry-run",
  "check-production-publish-gate.mjs",
]);

export const OBLIGATIONS = Object.freeze({
  MISSING_DOC: "release.rehearsal.missing_doc",
  DOC_INCOMPLETE: "release.rehearsal.doc_incomplete",
  FREEZE_LOCKED: "release.rehearsal.freeze_locked",
  WORKFLOW_UNWIRED: "release.rehearsal.workflow_unwired",
  DRY_RUN_FAILED: "release.rehearsal.dry_run_failed",
  PACKAGES_MISSING: "release.rehearsal.packages_missing",
  SOVEREIGNTY: "release.rehearsal.sovereignty",
  IDEMPOTENT_CONFLICT: "release.rehearsal.idempotent_conflict",
  PARTIAL_FAILURE: "release.rehearsal.partial_failure",
  INVALID_INPUT: "release.rehearsal.invalid_input",
});

const FORBIDDEN_CONTENT_KEY =
  /utterance|promptBody|replyBody|learnerContent|rawContent|rawKeystrokes|secret/i;
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const OPERATION_LIMIT = 256;

const rehearsalReceipts = new Map();

export class ReleaseTagRehearsalError extends Error {
  constructor(failureClass, message, details = {}) {
    super(message);
    this.name = "ReleaseTagRehearsalError";
    this.failureClass = failureClass;
    this.details = details;
  }
}

function emit(onTelemetry, event) {
  const payload = {
    event: "release.tag_rehearsal",
    ...event,
  };
  onTelemetry?.(payload);
  if (!onTelemetry) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  }
}

function assertNoRawContent(value, pathLabel = "root") {
  if (value === null || value === undefined) return;
  if (typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      assertNoRawContent(value[i], `${pathLabel}[${i}]`);
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_CONTENT_KEY.test(key)) {
      throw new ReleaseTagRehearsalError(
        OBLIGATIONS.SOVEREIGNTY,
        `forbidden content key ${key} at ${pathLabel}`,
        { key, pathLabel },
      );
    }
    assertNoRawContent(child, `${pathLabel}.${key}`);
  }
}

export function resetReleaseTagRehearsalState() {
  rehearsalReceipts.clear();
}

/** Verify the three launch-artifact docs land with required phrases. */
export function assertReleaseDocsLanded(input = {}) {
  const root = input.repoRoot ?? REPO_ROOT;
  const missing = [];
  const incomplete = [];
  for (const rel of RELEASE_DOCS) {
    const abs = path.join(root, rel);
    if (!existsSync(abs)) {
      missing.push(rel);
      continue;
    }
    const body = readFileSync(abs, "utf8");
    for (const phrase of RELEASE_DOC_REQUIRED_PHRASES[rel] ?? []) {
      if (!body.toLowerCase().includes(phrase.toLowerCase())) {
        incomplete.push(`${rel}: missing "${phrase}"`);
      }
    }
  }
  if (missing.length > 0) {
    throw new ReleaseTagRehearsalError(
      OBLIGATIONS.MISSING_DOC,
      `release docs missing: ${missing.join(", ")}`,
      { missing },
    );
  }
  if (incomplete.length > 0) {
    throw new ReleaseTagRehearsalError(
      OBLIGATIONS.DOC_INCOMPLETE,
      `release docs incomplete: ${incomplete.join("; ")}`,
      { incomplete },
    );
  }
  return { ok: true, docs: [...RELEASE_DOCS] };
}

/** Release executes only after A P7 freeze unlock. */
export function assertP7FreezeUnlocked(input = {}) {
  const root = input.repoRoot ?? REPO_ROOT;
  const rfcPath = path.join(root, "rfcs/0001-protocol-1.0-freeze.md");
  const gatePath = path.join(
    root,
    "rfcs/appendix/production-publish-gate.json",
  );
  if (!existsSync(rfcPath) || !existsSync(gatePath)) {
    throw new ReleaseTagRehearsalError(
      OBLIGATIONS.FREEZE_LOCKED,
      "P7 freeze RFC or production-publish-gate.json missing",
    );
  }
  const rfcBody = readFileSync(rfcPath, "utf8");
  const parsed = parseFreezeAcceptance(rfcBody);
  const gate = JSON.parse(readFileSync(gatePath, "utf8"));
  if (parsed.unlocked !== true || gate.unlocked !== true) {
    throw new ReleaseTagRehearsalError(
      OBLIGATIONS.FREEZE_LOCKED,
      `P7 freeze not unlocked (rfc=${parsed.unlocked} gate=${gate.unlocked}): ${parsed.reason}`,
      { reason: parsed.reason },
    );
  }
  return {
    ok: true,
    unlocked: true,
    rfcStatus: parsed.status,
    reason: parsed.reason,
  };
}

/** Cross-track-green → P5 publish dry-run wiring in release.yml. */
export function assertReleaseWorkflowWiring(input = {}) {
  const root = input.repoRoot ?? REPO_ROOT;
  const wfPath = path.join(root, RELEASE_WORKFLOW_RELPATH);
  if (!existsSync(wfPath)) {
    throw new ReleaseTagRehearsalError(
      OBLIGATIONS.WORKFLOW_UNWIRED,
      "release.yml missing",
    );
  }
  const text = readFileSync(wfPath, "utf8").replace(/\r\n/g, "\n");
  const missing = WORKFLOW_REQUIRED_PHRASES.filter((p) => !text.includes(p));
  if (missing.length > 0) {
    throw new ReleaseTagRehearsalError(
      OBLIGATIONS.WORKFLOW_UNWIRED,
      `release.yml missing wiring: ${missing.join(", ")}`,
      { missing },
    );
  }
  return { ok: true, workflow: RELEASE_WORKFLOW_RELPATH };
}

/**
 * Lightweight P5 dry-run: public package inventory + publish checklist.
 * Inject `dryRun` for tests.
 */
export function runP5PublishPipelineDryRun(input = {}) {
  const root = input.repoRoot ?? REPO_ROOT;
  if (typeof input.dryRun === "function") {
    const result = input.dryRun({ repoRoot: root });
    if (!result?.ok) {
      throw new ReleaseTagRehearsalError(
        OBLIGATIONS.DRY_RUN_FAILED,
        result?.detail ?? "injected P5 dry-run failed",
        { result },
      );
    }
    return {
      ok: true,
      mode: "injected",
      packagesVerified: result.packagesVerified ?? 0,
      packages: result.packages ?? [],
      detail: result.detail ?? "injected dry-run ok",
    };
  }

  const packagesRoot = path.join(root, "packages");
  if (!existsSync(packagesRoot)) {
    throw new ReleaseTagRehearsalError(
      OBLIGATIONS.PACKAGES_MISSING,
      "packages/ directory missing",
    );
  }
  const entries = [];
  for (const name of [
    "contracts",
    "sdk",
    "sync-protocol",
    "cognitive-core",
    "edge-agent",
    "telemetry",
  ]) {
    const pkgJson = path.join(packagesRoot, name, "package.json");
    if (!existsSync(pkgJson)) {
      throw new ReleaseTagRehearsalError(
        OBLIGATIONS.PACKAGES_MISSING,
        `expected public package missing: packages/${name}`,
        { package: name },
      );
    }
    const pkg = JSON.parse(readFileSync(pkgJson, "utf8"));
    if (pkg.private === true) {
      throw new ReleaseTagRehearsalError(
        OBLIGATIONS.DRY_RUN_FAILED,
        `package ${name} unexpectedly private for release dry-run`,
      );
    }
    if (!isPublishableNpmPackageName(pkg.name)) {
      throw new ReleaseTagRehearsalError(
        OBLIGATIONS.DRY_RUN_FAILED,
        `package ${name} is not a publishable npm package name`,
      );
    }
    entries.push(pkg.name);
  }

  const checklist = path.join(root, "docs/sdk/PUBLISH-CHECKLIST.md");
  if (!existsSync(checklist)) {
    throw new ReleaseTagRehearsalError(
      OBLIGATIONS.DRY_RUN_FAILED,
      "docs/sdk/PUBLISH-CHECKLIST.md missing",
    );
  }

  return {
    ok: true,
    mode: "inventory",
    packagesVerified: entries.length,
    packages: entries,
    detail: `verified ${entries.length} public packages + publish checklist`,
  };
}

/** Persist signed release record (atomic write). Idempotent on same operationId. */
export function signReleaseRecord(input) {
  assertNoRawContent(input, "signReleaseRecord");
  const {
    operationId,
    subjectId = "system:release-rehearsal",
    deviceId = hostname() || "unknown-device",
    freeze,
    workflow,
    docs,
    dryRun,
    repoRoot = REPO_ROOT,
    write = true,
    nowMs = () => Date.now(),
  } = input;

  if (!ID_RE.test(operationId) || !ID_RE.test(subjectId)) {
    throw new ReleaseTagRehearsalError(
      OBLIGATIONS.INVALID_INPUT,
      "operationId/subjectId must match opaque id grammar",
    );
  }
  if (rehearsalReceipts.size >= OPERATION_LIMIT) {
    throw new ReleaseTagRehearsalError(
      OBLIGATIONS.PARTIAL_FAILURE,
      `rehearsal receipts exceed ${OPERATION_LIMIT}`,
    );
  }

  const prior = rehearsalReceipts.get(operationId);
  if (prior) {
    if (prior.subjectId !== subjectId) {
      throw new ReleaseTagRehearsalError(
        OBLIGATIONS.IDEMPOTENT_CONFLICT,
        "operationId already bound to a different subjectId",
      );
    }
    return { ok: true, record: prior, idempotentReplay: true };
  }

  const signedAt = new Date(nowMs()).toISOString();
  const record = {
    schemaVersion: "release.tag-rehearsal.record.v1",
    kind: "release-record",
    version: "1.0.0",
    operationId,
    subjectId,
    deviceId,
    signedAt,
    checklist: {
      crossTrackGreenWiring: workflow?.ok === true,
      p7FreezeUnlocked: freeze?.unlocked === true,
      releaseDocsLanded: Array.isArray(docs?.docs) && docs.docs.length === 3,
      p5PublishDryRun: dryRun?.ok === true,
      packagesVerified: dryRun?.packagesVerified ?? 0,
    },
    evidence: {
      freezeReason: freeze?.reason ?? null,
      workflow: workflow?.workflow ?? RELEASE_WORKFLOW_RELPATH,
      docs: docs?.docs ?? [...RELEASE_DOCS],
      dryRunDetail: dryRun?.detail ?? null,
      packages: dryRun?.packages ?? [],
    },
    outcome: "signed",
    attestors: [
      { role: "release-operator", attestorId: subjectId, signedAt },
      {
        role: "pipeline",
        attestorId: "a-p5-publish-pipeline",
        signedAt,
      },
    ],
  };

  assertNoRawContent(record, "release-record");

  if (write) {
    const abs = path.join(repoRoot, RELEASE_RECORD_RELPATH);
    mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.${operationId.replace(/[^a-zA-Z0-9._-]/g, "_")}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
      renameSync(tmp, abs);
    } catch (err) {
      throw new ReleaseTagRehearsalError(
        OBLIGATIONS.PARTIAL_FAILURE,
        `failed to persist release record: ${err instanceof Error ? err.message : "io"}`,
      );
    }
  }

  rehearsalReceipts.set(operationId, record);
  return { ok: true, record, idempotentReplay: false };
}

/** Full tag rehearsal: docs → freeze → workflow → dry-run → signed record. */
export function runReleaseTagRehearsal(input = {}) {
  const repoRoot = input.repoRoot ?? REPO_ROOT;
  const subjectId = input.subjectId ?? "system:release-rehearsal";
  const deviceId = input.deviceId ?? (hostname() || "unknown-device");
  const operationId =
    input.operationId ?? `op.release.rehearsal.${Date.now()}`;
  const onTelemetry = input.onTelemetry;
  const write = input.write !== false;

  assertNoRawContent(
    {
      operationId,
      subjectId,
      deviceId,
      ...(input.utterance !== undefined ? { utterance: input.utterance } : {}),
    },
    "runReleaseTagRehearsal",
  );

  try {
    emit(onTelemetry, {
      outcome: "start",
      subjectId,
      deviceId,
      operationId,
      action: "start",
    });

    const docs = assertReleaseDocsLanded({ repoRoot });
    emit(onTelemetry, {
      outcome: "ok",
      subjectId,
      deviceId,
      operationId,
      action: "assert_docs",
    });

    const freeze = assertP7FreezeUnlocked({ repoRoot });
    emit(onTelemetry, {
      outcome: "ok",
      subjectId,
      deviceId,
      operationId,
      action: "assert_freeze",
    });

    const workflow = assertReleaseWorkflowWiring({ repoRoot });
    emit(onTelemetry, {
      outcome: "ok",
      subjectId,
      deviceId,
      operationId,
      action: "assert_workflow",
    });

    const dryRun = runP5PublishPipelineDryRun({
      repoRoot,
      ...(typeof input.dryRun === "function" ? { dryRun: input.dryRun } : {}),
    });
    emit(onTelemetry, {
      outcome: "ok",
      subjectId,
      deviceId,
      operationId,
      action: "p5_dry_run",
      packagesVerified: dryRun.packagesVerified,
    });

    const signed = signReleaseRecord({
      operationId,
      subjectId,
      deviceId,
      freeze,
      workflow,
      docs,
      dryRun,
      repoRoot,
      write,
      ...(input.nowMs ? { nowMs: input.nowMs } : {}),
    });

    emit(onTelemetry, {
      outcome: signed.idempotentReplay ? "idempotent_replay" : "ok",
      subjectId,
      deviceId,
      operationId,
      action: "sign_record",
      releaseRecord: RELEASE_RECORD_RELPATH,
    });

    return {
      ok: true,
      docs,
      freeze,
      workflow,
      dryRun,
      signed,
      releaseRecordPath: RELEASE_RECORD_RELPATH,
    };
  } catch (err) {
    const failureClass =
      err instanceof ReleaseTagRehearsalError
        ? err.failureClass
        : OBLIGATIONS.PARTIAL_FAILURE;
    emit(onTelemetry, {
      outcome: "rejected",
      subjectId,
      deviceId,
      operationId,
      action: "fail",
      failureClass,
      detail: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export function proveReleaseTagRehearsal(input = {}) {
  resetReleaseTagRehearsalState();
  const repoRoot = input.repoRoot ?? REPO_ROOT;
  const deviceId = input.deviceId ?? "ci-release-tag-rehearsal";
  const events = [];
  const onTelemetry = (e) => {
    events.push(e);
    input.onTelemetry?.(e);
  };

  const happy = runReleaseTagRehearsal({
    repoRoot,
    deviceId,
    subjectId: "system:release-rehearsal",
    operationId: "op.release.rehearsal.prove",
    write: input.write !== false,
    onTelemetry,
  });

  const replay = runReleaseTagRehearsal({
    repoRoot,
    deviceId,
    subjectId: "system:release-rehearsal",
    operationId: "op.release.rehearsal.prove",
    write: input.write !== false,
    onTelemetry,
  });

  let sovereigntyRejected = false;
  try {
    runReleaseTagRehearsal({
      repoRoot,
      deviceId,
      subjectId: "system:release-rehearsal",
      operationId: "op.release.rehearsal.raw",
      write: false,
      utterance: "must never appear",
      onTelemetry,
    });
  } catch (err) {
    sovereigntyRejected =
      err instanceof ReleaseTagRehearsalError &&
      err.failureClass === OBLIGATIONS.SOVEREIGNTY;
  }

  const proof = {
    ok: true,
    happySigned: happy.ok === true && happy.signed.ok === true,
    idempotentReplay: replay.signed.idempotentReplay === true,
    sovereigntyRejected,
    docsLanded: happy.docs.ok === true,
    freezeUnlocked: happy.freeze.unlocked === true,
    workflowWired: happy.workflow.ok === true,
    dryRunOk: happy.dryRun.ok === true,
    events,
  };

  if (
    !proof.happySigned ||
    !proof.idempotentReplay ||
    !proof.sovereigntyRejected ||
    !proof.docsLanded ||
    !proof.freezeUnlocked ||
    !proof.workflowWired ||
    !proof.dryRunOk
  ) {
    throw new ReleaseTagRehearsalError(
      OBLIGATIONS.PARTIAL_FAILURE,
      "release tag rehearsal prove failed",
      { proof },
    );
  }
  return proof;
}

function main(argv = process.argv.slice(2)) {
  const write = argv.includes("--write") || !argv.includes("--check-only");
  const prove = argv.includes("--prove");
  try {
    if (prove) {
      const proof = proveReleaseTagRehearsal({ write });
      process.stdout.write(
        `${JSON.stringify({
          event: "release.tag_rehearsal.prove",
          outcome: "ok",
          subjectId: "system:release-rehearsal",
          deviceId: hostname() || "ci",
          happySigned: proof.happySigned,
          idempotentReplay: proof.idempotentReplay,
          sovereigntyRejected: proof.sovereigntyRejected,
        })}\n`,
      );
      return 0;
    }
    const result = runReleaseTagRehearsal({ write });
    process.stdout.write(
      `${JSON.stringify({
        event: "release.tag_rehearsal.completed",
        outcome: "ok",
        subjectId: "system:release-rehearsal",
        deviceId: hostname() || "ci",
        releaseRecordPath: result.releaseRecordPath,
        packagesVerified: result.dryRun.packagesVerified,
        idempotentReplay: result.signed.idempotentReplay,
      })}\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(
      `release tag rehearsal failed: ${err instanceof Error ? err.message : err}\n`,
    );
    return 1;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main();
}
