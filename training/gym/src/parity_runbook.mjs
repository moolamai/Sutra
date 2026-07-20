/**
 * Parity fixture regeneration runbook coherence — governance lock.
 * CI / unit tests assert the runbook exists and encodes never-auto-accept.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GYM_ROOT = join(__dirname, "..");

/** Repo-relative path (product language for operators / tests). */
export const PARITY_FIXTURE_RUNBOOK_RELPATH =
  "training/gym/docs/parity-fixture-regeneration.md";

export const PARITY_FIXTURE_RUNBOOK_ABS = join(
  GYM_ROOT,
  "docs",
  "parity-fixture-regeneration.md",
);

/** Phrases the runbook must encode (never-auto-accept + human review). */
export const PARITY_FIXTURE_RUNBOOK_REQUIRED_PHRASES = Object.freeze([
  "Never auto-accept",
  "human review",
  "firstDivergentFrameIndex",
  "ci:parity",
  "golden:write",
  "golden:check",
  "golden:sync",
  "TURN_COMPLETE",
  "HARNESS_ERROR",
  "subjectId",
  "frame-sequence identity",
  "never auto-commits",
  "Workflow B",
  "canonical_drift",
]);

/**
 * Soft-load the runbook text.
 * @param {{ deviceId?: string, onTelemetry?: (e: object) => void }} [opts]
 */
export function loadParityFixtureRunbook(opts = {}) {
  const deviceId = opts.deviceId ?? "dev-parity-runbook";
  if (!existsSync(PARITY_FIXTURE_RUNBOOK_ABS)) {
    opts.onTelemetry?.({
      event: "training.gym.replay_parity",
      phase: "runbook",
      outcome: "rejected",
      subjectId: null,
      deviceId,
      failureClass: "missing_corpus",
      detail: `runbook missing at ${PARITY_FIXTURE_RUNBOOK_RELPATH}`,
    });
    return {
      ok: false,
      failureClass: "missing_corpus",
      detail: `runbook missing at ${PARITY_FIXTURE_RUNBOOK_RELPATH}`,
      text: "",
      subjectId: null,
      deviceId,
    };
  }
  const text = readFileSync(PARITY_FIXTURE_RUNBOOK_ABS, "utf8");
  opts.onTelemetry?.({
    event: "training.gym.replay_parity",
    phase: "runbook",
    outcome: "ok",
    subjectId: null,
    deviceId,
    detail: "parity fixture regeneration runbook loaded",
  });
  return {
    ok: true,
    text,
    subjectId: null,
    deviceId,
    failureClass: null,
    detail: null,
  };
}

/**
 * Assert runbook encodes intentional-bump governance (never auto-accept).
 * @param {{ deviceId?: string, onTelemetry?: (e: object) => void }} [opts]
 */
export function assertParityFixtureRunbookCoherence(opts = {}) {
  const deviceId = opts.deviceId ?? "dev-parity-runbook";
  const loaded = loadParityFixtureRunbook({
    deviceId,
    onTelemetry: opts.onTelemetry,
  });
  if (!loaded.ok) {
    return loaded;
  }

  const missing = [];
  for (const phrase of PARITY_FIXTURE_RUNBOOK_REQUIRED_PHRASES) {
    if (!loaded.text.includes(phrase)) {
      missing.push(phrase);
    }
  }

  // Forbid affirmative CI auto-accept recipes (voids the gate).
  if (/CI will auto-update|auto-accept drift|silently update fixtures/i.test(loaded.text)) {
    opts.onTelemetry?.({
      event: "training.gym.replay_parity",
      phase: "runbook",
      outcome: "rejected",
      subjectId: null,
      deviceId,
      failureClass: "schema_violation",
      detail: "runbook must not instruct CI auto-accept of fixture drift",
    });
    return {
      ok: false,
      failureClass: "schema_violation",
      detail: "runbook must not instruct CI auto-accept of fixture drift",
      subjectId: null,
      deviceId,
      missingPhrases: [],
    };
  }

  if (missing.length > 0) {
    opts.onTelemetry?.({
      event: "training.gym.replay_parity",
      phase: "runbook",
      outcome: "rejected",
      subjectId: null,
      deviceId,
      failureClass: "schema_violation",
      detail: `runbook missing phrases: ${missing.join(",")}`,
    });
    return {
      ok: false,
      failureClass: "schema_violation",
      detail: `runbook missing phrases: ${missing.join(",")}`,
      subjectId: null,
      deviceId,
      missingPhrases: missing,
    };
  }

  // Scripts referenced must not auto-commit (spot-check compile script).
  const compileScript = join(GYM_ROOT, "scripts", "compile-golden-scenarios.mjs");
  if (existsSync(compileScript)) {
    const body = readFileSync(compileScript, "utf8");
    if (/\bgit\s+commit\b/.test(body)) {
      return {
        ok: false,
        failureClass: "schema_violation",
        detail: "golden compile script must never git commit",
        subjectId: null,
        deviceId,
        missingPhrases: [],
      };
    }
  }

  opts.onTelemetry?.({
    event: "training.gym.replay_parity",
    phase: "runbook",
    outcome: "ok",
    subjectId: null,
    deviceId,
    detail: "parity fixture regeneration runbook coherent",
  });

  return {
    ok: true,
    subjectId: null,
    deviceId,
    missingPhrases: [],
    failureClass: null,
    detail: null,
  };
}
