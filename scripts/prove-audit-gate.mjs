/**
 * Red→green proof for the dependency audit gate (SEC-02).
 *
 *   1. Baseline green on committed suppressions + audits
 *   2. Seed an expired suppression → gate red naming the advisory id
 *   3. Revert → green
 *   4. Seed an un-suppressed critical/high finding → gate red with advisory ids
 *   5. Revert → green
 *
 * Always restores security/AUDIT-SUPPRESSIONS.json in finally.
 *
 * Usage (repo root):
 *   node scripts/prove-audit-gate.mjs
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SUPPRESSIONS_PATH,
  runAuditGate,
} from "./run-audit-gate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

export const SEED_MARKER = "AUDIT_GATE_PROVE_SEED";
export const SEED_ADVISORY_ID = "GHSA-prove-unsuppressed-0001";

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "audit_gate.prove", ...event })}\n`,
  );
}

/**
 * @param {string} body
 */
export function seedExpiredSuppression(body) {
  if (body.includes(SEED_MARKER)) {
    throw new Error("AUDIT_GATE_PROVE_ALREADY_SEEDED: clean tree before proving");
  }
  const doc = JSON.parse(body);
  doc.suppressions.push({
    advisoryIds: ["GHSA-expired-prove-seed"],
    ecosystem: "npm",
    package: "prove-seed-package",
    severity: "high",
    owner: "prove seed",
    expiresOn: "2020-01-01",
    rationale: `${SEED_MARKER} temporary expired suppression for prove gate`,
  });
  return JSON.stringify(doc, null, 2) + "\n";
}

/**
 * Inject a fake un-suppressed high npm finding into a mocked pnpm audit run.
 */
export function fakePnpmWithUnsuppressed(baseStdout) {
  const data = JSON.parse(baseStdout || "{}");
  data.advisories = data.advisories ?? {};
  data.advisories[SEED_ADVISORY_ID] = {
    id: 9999999,
    severity: "high",
    module_name: "prove-seed-package",
    title: `${SEED_MARKER} injected high advisory`,
    github_advisory_id: SEED_ADVISORY_ID,
    cves: ["CVE-PROVE-0001"],
  };
  return JSON.stringify(data);
}

/**
 * @param {{
 *   suppressionsPath?: string,
 *   runGate?: typeof runAuditGate,
 * }} [opts]
 */
export function proveAuditGate(opts = {}) {
  const suppressionsPath = opts.suppressionsPath ?? SUPPRESSIONS_PATH;
  const gate = opts.runGate ?? runAuditGate;
  /** @type {object[]} */
  const phases = [];
  /** @type {string[]} */
  const failures = [];
  /** @type {string | null} */
  let original = null;

  const phase = (name, outcome, extra = {}) => {
    phases.push({ phase: name, outcome, ...extra });
    emit({ phase: name, outcome, ...extra });
  };

  emit({ outcome: "start" });

  try {
    const baseline = gate({ suppressionsPath });
    phase("baseline", baseline.ok ? "ok" : "error", {
      blocking: baseline.blocking?.length ?? 0,
    });
    if (!baseline.ok) {
      failures.push(
        "BASELINE_NOT_GREEN:\n" + (baseline.failures?.join("\n") ?? ""),
      );
      return { ok: false, phases, failures };
    }

    original = readFileSync(suppressionsPath, "utf8");

    // --- expired suppression → red ---
    writeFileSync(suppressionsPath, seedExpiredSuppression(original), "utf8");
    const expired = gate({ suppressionsPath });
    const expiredNamed = expired.failures?.some((f) =>
      f.includes("expired_suppression"),
    );
    phase("expired-suppression-red", expired.ok === false && expiredNamed ? "ok" : "error", {
      named: expiredNamed,
    });
    if (expired.ok || !expiredNamed) {
      failures.push(
        expired.ok
          ? "EXPIRED_SUPPRESSION_DID_NOT_FAIL"
          : "EXPIRED_SUPPRESSION_NO_DIFF:\n" +
              (expired.failures?.join("\n") ?? ""),
      );
    }

    writeFileSync(suppressionsPath, original, "utf8");
    const afterExpired = gate({ suppressionsPath });
    phase(
      "revert-expired-green",
      afterExpired.ok ? "ok" : "error",
    );
    if (!afterExpired.ok) {
      failures.push("REVERT_NOT_GREEN after expired seed");
    }

    // --- un-suppressed finding → red naming advisory ids ---
    let pnpmStdout = "{}";
    try {
      const live = gate({ suppressionsPath });
      pnpmStdout = live.allFindings
        ? JSON.stringify({ advisories: {} })
        : "{}";
    } catch {
      pnpmStdout = "{}";
    }
  const seededPnpm = fakePnpmWithUnsuppressed(pnpmStdout);
    const unsuppressed = gate({
      suppressionsPath,
      runPnpm: () => ({ status: 1, stdout: seededPnpm, stderr: "" }),
      runPip: () => ({
        status: 0,
        stdout: JSON.stringify({ dependencies: [] }),
        stderr: "",
      }),
    });
    const unsuppressedNamed =
      unsuppressed.failures?.some((f) =>
        f.includes(SEED_ADVISORY_ID) || f.includes("9999999"),
      ) &&
      (unsuppressed.failureLines?.length ?? 0) > 0;
    phase(
      "unsuppressed-finding-red",
      unsuppressed.ok === false && unsuppressedNamed ? "ok" : "error",
      { named: unsuppressedNamed },
    );
    if (unsuppressed.ok || !unsuppressedNamed) {
      failures.push(
        unsuppressed.ok
          ? "UNSUPPRESSED_FINDING_DID_NOT_FAIL"
          : "UNSUPPRESSED_FINDING_NO_DIFF:\n" +
              (unsuppressed.failures?.join("\n") ?? "") +
              "\n" +
              (unsuppressed.failureLines?.join("\n") ?? ""),
      );
    }

    writeFileSync(suppressionsPath, original, "utf8");
    original = null;
    const finalGreen = gate({ suppressionsPath });
    phase("reverted-green", finalGreen.ok ? "ok" : "error");
    if (!finalGreen.ok) {
      failures.push("REVERT_NOT_GREEN after unsuppressed seed");
    }

    const restored = readFileSync(suppressionsPath, "utf8");
    if (restored.includes(SEED_MARKER)) {
      failures.push("SEED_LEFT_BEHIND in suppressions file");
    }

    const ok = failures.length === 0;
    emit({
      outcome: ok ? "ok" : "error",
      failureCount: failures.length,
      phases: phases.map((p) => p.phase),
    });
    return { ok, phases, failures, unsuppressedLog: unsuppressed.failureLines };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failures.push(message);
    emit({ outcome: "error", message });
    return { ok: false, phases, failures };
  } finally {
    if (original !== null && existsSync(suppressionsPath)) {
      writeFileSync(suppressionsPath, original, "utf8");
      emit({ phase: "restore-finally", outcome: "ok" });
    }
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isMain) {
  const result = proveAuditGate();
  if (!result.ok) {
    for (const block of result.failures) {
      console.error("\n======== AUDIT GATE PROVE FAILED ========\n");
      console.error(block);
    }
    process.exitCode = 1;
  }
}
