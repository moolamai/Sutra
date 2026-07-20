/**
 * Red→green proof for the threat-model regression gate (SEC-01).
 *
 * Operator path the CI job requires:
 *   1. Baseline green — inventory + STRIDE gates pass on the committed model
 *   2. Seed a broken mitigation test link → gate red, stderr names the
 *      offending threat ID and the unresolved path
 *   3. Revert → green
 *   4. Seed a prose-only mitigation (test link removed) → gate red, stderr
 *      names the threat ID missing a test
 *   5. Revert → green
 *
 * Always restores security/THREAT-MODEL.md (finally), so a mid-run interrupt
 * cannot leave the tree with a seeded violation.
 *
 * Usage (repo root):
 *   node scripts/prove-threat-model-gate.mjs
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { THREAT_MODEL } from "./check-threat-model-inventory.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

/** Threat row targeted by both seeds — stable ID from the committed model. */
export const SEED_THREAT_ID = "TH-EDGE-001";
/** Unresolvable path — must appear verbatim in the failing gate output. */
export const SEED_BROKEN_LINK =
  "packages/cognitive-core/tests/__threat_model_prove_missing__.test.mjs";
export const SEED_MARKER = "THREAT_MODEL_PROVE_SEED";

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "threat_model.ci.prove", ...event })}\n`,
  );
}

function runGateScript(script) {
  const result = spawnSync(process.execPath, [`scripts/${script}`], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: process.env,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    combined: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  };
}

export function runInventoryGate() {
  return runGateScript("check-threat-model-inventory.mjs");
}

export function runStrideGate() {
  return runGateScript("check-threat-model-stride.mjs");
}

/**
 * Find the STRIDE table row for a threat ID.
 * @param {string} body
 * @param {string} threatId
 */
function threatRow(body, threatId) {
  const row = body
    .split(/\r?\n/)
    .find((line) => line.startsWith("|") && line.includes(`\`${threatId}\``));
  if (!row) {
    throw new Error(
      `THREAT_MODEL_PROVE_SEED_FAILED: no table row for ${threatId}`,
    );
  }
  return row;
}

/**
 * Replace the threat's test link with a path that does not exist on disk.
 * Only the targeted row changes — every other byte is preserved.
 * @param {string} body
 * @param {string} [threatId]
 */
export function seedBrokenTestLink(body, threatId = SEED_THREAT_ID) {
  if (body.includes(SEED_MARKER)) {
    throw new Error(
      "THREAT_MODEL_PROVE_ALREADY_SEEDED: clean tree before proving",
    );
  }
  const row = threatRow(body, threatId);
  const seededRow = row.replace(
    /`((?:packages|scripts)\/[^`]+\.(?:test\.mjs|py))`/,
    `\`${SEED_BROKEN_LINK}\` <!-- ${SEED_MARKER} -->`,
  );
  if (seededRow === row) {
    throw new Error(
      `THREAT_MODEL_PROVE_SEED_FAILED: no test link in row for ${threatId}`,
    );
  }
  return body.replace(row, seededRow);
}

/**
 * Strip the threat's test link entirely — a prose-only mitigation.
 * @param {string} body
 * @param {string} [threatId]
 */
export function seedMissingTestLink(body, threatId = SEED_THREAT_ID) {
  if (body.includes(SEED_MARKER)) {
    throw new Error(
      "THREAT_MODEL_PROVE_ALREADY_SEEDED: clean tree before proving",
    );
  }
  const row = threatRow(body, threatId);
  const seededRow = row.replace(
    /`(?:packages|scripts)\/[^`]+\.(?:test\.mjs|py)`/,
    `prose-only mitigation <!-- ${SEED_MARKER} -->`,
  );
  if (seededRow === row) {
    throw new Error(
      `THREAT_MODEL_PROVE_SEED_FAILED: no test link in row for ${threatId}`,
    );
  }
  return body.replace(row, seededRow);
}

/**
 * @param {{
 *   threatModelPath?: string,
 *   runInventory?: () => { status: number, combined: string },
 *   runStride?: () => { status: number, combined: string },
 * }} [opts]
 * @returns {{ ok: boolean, phases: object[], failures: string[], brokenLog?: string, missingLog?: string }}
 */
export function proveThreatModelGate(opts = {}) {
  const threatModelPath = opts.threatModelPath ?? THREAT_MODEL;
  const runInventory = opts.runInventory ?? runInventoryGate;
  const runStride = opts.runStride ?? runStrideGate;

  /** @type {object[]} */
  const phases = [];
  /** @type {string[]} */
  const failures = [];
  /** @type {string | null} */
  let original = null;
  let brokenLog = "";
  let missingLog = "";

  const phase = (name, outcome, extra = {}) => {
    phases.push({ phase: name, outcome, ...extra });
    emit({ phase: name, outcome, ...extra });
  };

  emit({ outcome: "start", threatId: SEED_THREAT_ID });

  try {
    // --- Phase A: baseline must be green on both gates ---
    const inv = runInventory();
    const stride = runStride();
    const baselineOk = inv.status === 0 && stride.status === 0;
    phase("baseline", baselineOk ? "ok" : "error", {
      inventoryExit: inv.status,
      strideExit: stride.status,
    });
    if (!baselineOk) {
      failures.push(
        "BASELINE_NOT_GREEN: gates must pass before seeding a violation.\n" +
          `${inv.combined}\n${stride.combined}`,
      );
      return { ok: false, phases, failures };
    }

    original = readFileSync(threatModelPath, "utf8");

    // --- Phase B: broken test link → red naming the offender ---
    writeFileSync(threatModelPath, seedBrokenTestLink(original), "utf8");
    const broken = runStride();
    brokenLog = broken.combined;
    const brokenNamed =
      broken.combined.includes(SEED_THREAT_ID) &&
      broken.combined.includes(SEED_BROKEN_LINK);
    const brokenOk = broken.status !== 0 && brokenNamed;
    phase("broken-link-red", brokenOk ? "ok" : "error", {
      exitCode: broken.status,
      namedOffender: brokenNamed,
    });
    if (broken.status === 0) {
      failures.push(
        "SEEDED_BROKEN_LINK_DID_NOT_FAIL: gate stayed green with an unresolvable test link.",
      );
    } else if (!brokenNamed) {
      failures.push(
        "SEEDED_BROKEN_LINK_NO_DIFF: gate failed without naming the threat ID and unresolved path.\n" +
          broken.combined.slice(0, 4000),
      );
    }

    writeFileSync(threatModelPath, original, "utf8");
    const greenAfterBroken = runStride();
    phase(
      "revert-broken-green",
      greenAfterBroken.status === 0 ? "ok" : "error",
      { exitCode: greenAfterBroken.status },
    );
    if (greenAfterBroken.status !== 0) {
      failures.push(
        "REVERT_NOT_GREEN: gate still failing after restoring the broken-link seed.\n" +
          greenAfterBroken.combined.slice(0, 4000),
      );
    }

    // --- Phase C: prose-only mitigation → red naming the threat ---
    writeFileSync(threatModelPath, seedMissingTestLink(original), "utf8");
    const missing = runStride();
    missingLog = missing.combined;
    const missingNamed =
      missing.combined.includes("missing_test_link") &&
      missing.combined.includes(SEED_THREAT_ID);
    const missingOk = missing.status !== 0 && missingNamed;
    phase("missing-link-red", missingOk ? "ok" : "error", {
      exitCode: missing.status,
      namedOffender: missingNamed,
    });
    if (missing.status === 0) {
      failures.push(
        "SEEDED_MISSING_LINK_DID_NOT_FAIL: gate stayed green with a prose-only mitigation.",
      );
    } else if (!missingNamed) {
      failures.push(
        "SEEDED_MISSING_LINK_NO_DIFF: gate failed without naming the prose-only threat.\n" +
          missing.combined.slice(0, 4000),
      );
    }

    writeFileSync(threatModelPath, original, "utf8");
    const restored = readFileSync(threatModelPath, "utf8");
    original = null;
    const finalGreen = runStride();
    phase("reverted-green", finalGreen.status === 0 ? "ok" : "error", {
      exitCode: finalGreen.status,
    });
    if (finalGreen.status !== 0) {
      failures.push(
        "REVERT_NOT_GREEN: gate still failing after restoring THREAT-MODEL.md.\n" +
          finalGreen.combined.slice(0, 4000),
      );
    }

    // Subject-isolation sanity: the restored model still binds every
    // boundary to subjectId scoping, and no seed marker was left behind.
    if (!restored.includes("subjectId")) {
      failures.push(
        "SUBJECT_ISOLATION_BROKEN: restored THREAT-MODEL.md lost subjectId scoping.",
      );
    }
    if (restored.includes(SEED_MARKER)) {
      failures.push(
        "SEED_LEFT_BEHIND: prove marker still present after revert.",
      );
    }

    const ok = failures.length === 0;
    emit({
      outcome: ok ? "ok" : "error",
      failureCount: failures.length,
      phases: phases.map((p) => p.phase),
    });
    return { ok, phases, failures, brokenLog, missingLog };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failures.push(message);
    emit({ outcome: "error", code: "THREAT_MODEL_PROVE_FAILED", message });
    return { ok: false, phases, failures, brokenLog, missingLog };
  } finally {
    if (original !== null && existsSync(threatModelPath)) {
      try {
        writeFileSync(threatModelPath, original, "utf8");
        emit({ phase: "restore-finally", outcome: "ok" });
      } catch (restoreErr) {
        emit({
          phase: "restore-finally",
          outcome: "error",
          message:
            restoreErr instanceof Error
              ? restoreErr.message
              : String(restoreErr),
        });
      }
    }
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isMain) {
  const result = proveThreatModelGate();
  if (!result.ok) {
    for (const block of result.failures) {
      console.error("\n======== THREAT MODEL PROVE FAILED ========\n");
      console.error(block);
    }
    process.exitCode = 1;
  }
}
