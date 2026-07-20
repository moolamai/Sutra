/**
 * Seed-violation proof for every dependency-direction rule .
 *
 * Operator path:
 *   1. Baseline green (current tree / deps:lint)
 *   2. For each rule: scratch-tree seed → red with exact rule id + file→edge
 *   3. Baseline green again (tree never mutated)
 *
 * Type-only imports count as edges (CK-01) — proven via the contracts-type-only seed.
 *
 * Usage (repo root):
 *   node scripts/prove-dependency-direction-gate.mjs
 *   pnpm deps:lint:prove
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RULE_IDS,
  runDependencyDirectionGate,
  runSeededDependencyViolation,
  formatViolationEdges,
} from "./check-dependency-direction.mjs";

/** Ordered seed matrix — one entry per forbidden rule. */
export const SEED_MATRIX = Object.freeze([
  {
    kind: "contracts-type-only",
    ruleId: RULE_IDS.CONTRACTS_IMPORT_NOTHING,
    /**
     * Exact failure shape: rule id, offending file path segment, and import target.
     * Type-only `import type { ZodType } from "zod"` must count as an edge.
     */
    expectFrom: /packages[/\\]contracts[/\\]src[/\\]index\.ts/,
    expectTo: /zod/i,
    notes: "type-only import counts as a dependency edge (tsPreCompilationDeps)",
  },
  {
    kind: "domains",
    ruleId: RULE_IDS.NO_IMPORT_DOMAINS,
    expectFrom: /leak\.ts/,
    expectTo: /domains[/\\]teacher/,
    notes: "domains/** is forbidden as an import target repo-wide",
  },
  {
    kind: "relative-cross-package",
    ruleId: RULE_IDS.NO_RELATIVE_CROSS_PACKAGE,
    expectFrom: /escape\.ts/,
    expectTo: /cognitive-core/,
    notes: "relative escape into another package src is forbidden",
  },
  {
    kind: "gym-forbidden-package",
    ruleId: RULE_IDS.ANTI_CHEAT_GYM_FORBIDDEN_PKG,
    expectFrom: /fork_path\.mjs/,
    expectTo: /cognitive-core/,
    notes: "training/gym may reach packages/runtime-harness only",
  },
  {
    kind: "training-relative-harness-src",
    ruleId: RULE_IDS.ANTI_CHEAT_NO_RELATIVE_HARNESS_SRC,
    expectFrom: /deep_import\.mjs/,
    expectTo: /runtime-harness[/\\]src/,
    notes: "training/ must use @moolam/runtime-harness, not relative src",
  },
  {
    kind: "harness-reimplementation",
    ruleId: RULE_IDS.ANTI_CHEAT_HARNESS_REIMPL,
    expectFrom: /local_parser\.mjs/,
    expectTo: /ToolCallParser/,
    notes: "local harness primitive definitions under training/ are forbidden",
  },
]);

/** Bound on seed phases (NFR — no unbounded prove loop). */
export const SEED_PHASE_LIMIT = SEED_MATRIX.length;

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({
      event: "dependency.direction.prove",
      ...event,
    })}\n`,
  );
}

/**
 * Assert one seeded violation matches the exact rule + file→edge contract.
 * @param {typeof SEED_MATRIX[number]} spec
 * @param {Awaited<ReturnType<typeof runSeededDependencyViolation>>} seeded
 */
export function assertExactSeedFailure(spec, seeded) {
  if (seeded.status === 0) {
    return {
      ok: false,
      failure: `SEED_UNEXPECTED_GREEN:${spec.kind}:${spec.ruleId}`,
    };
  }
  const hit = seeded.violations.find(
    (v) =>
      v.rule === spec.ruleId &&
      spec.expectFrom.test(v.from) &&
      spec.expectTo.test(String(v.to)),
  );
  if (!hit) {
    return {
      ok: false,
      failure:
        `SEED_MISSING_EXACT_EDGE:${spec.kind}: expected rule=${spec.ruleId} ` +
        `from~${spec.expectFrom} to~${spec.expectTo}\n` +
        `got:\n${seeded.edgeText || "(no edges)"}`,
    };
  }
  const line = formatViolationEdges([hit]);
  if (!line.includes("→") || !line.includes(spec.ruleId)) {
    return {
      ok: false,
      failure: `SEED_GENERIC_MESSAGE:${spec.kind}: expected rule+file→edge, got ${line}`,
    };
  }
  return { ok: true, hit, line };
}

/**
 * Full green→(red×rules)→green proof. Idempotent: seeds live in temp dirs only.
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   completionRecord: object,
 *   failures: string[],
 * }>}
 */
export async function proveDependencyDirectionGate({
  subjectId = "subj-deps-prove",
  deviceId = "dev-deps-prove",
} = {}) {
  /** @type {string[]} */
  const failures = [];
  /** @type {object[]} */
  const seedResults = [];

  emit({
    outcome: "start",
    phase: "prove",
    subjectId,
    deviceId,
    seedCount: SEED_PHASE_LIMIT,
  });

  // --- Phase A: baseline green ---
  const baseline = await runDependencyDirectionGate({
    subjectId: `${subjectId}.baseline`,
    deviceId,
    emitEvents: false,
  });
  emit({
    outcome: baseline.status === 0 ? "ok" : "fail",
    phase: "baseline.green",
    subjectId: `${subjectId}.baseline`,
    deviceId,
    exitCode: baseline.status,
    violationCount: baseline.violations.length,
  });
  if (baseline.status !== 0) {
    failures.push(
      `BASELINE_NOT_GREEN:\n${(baseline.combined ?? "").slice(0, 4000)}`,
    );
    const completionRecord = buildCompletionRecord({
      ok: false,
      seedResults,
      failures,
      subjectId,
      deviceId,
    });
    emit({ outcome: "fail", phase: "prove.complete", subjectId, deviceId });
    return { ok: false, completionRecord, failures };
  }

  // --- Phase B: each rule seeded red with exact message ---
  if (SEED_MATRIX.length > SEED_PHASE_LIMIT) {
    failures.push("SEED_PHASE_UNBOUNDED");
  }
  for (const spec of SEED_MATRIX.slice(0, SEED_PHASE_LIMIT)) {
    const seeded = await runSeededDependencyViolation(spec.kind);
    const check = assertExactSeedFailure(spec, seeded);
    const entry = {
      kind: spec.kind,
      ruleId: spec.ruleId,
      notes: spec.notes,
      status: seeded.status,
      ok: check.ok,
      exactFailure: check.line ?? null,
      failure: check.failure ?? null,
    };
    seedResults.push(entry);

    // Loud file→edge line in operator logs (never a bare boolean).
    if (check.line) {
      process.stdout.write(`${check.line}\n`);
    }

    emit({
      outcome: check.ok ? "ok" : "fail",
      phase: `seeded.red.${spec.kind}`,
      subjectId: `${subjectId}.seed.${spec.kind}`,
      deviceId,
      ruleId: spec.ruleId,
      exitCode: seeded.status,
      exactFailure: check.line ?? undefined,
      failureClass: check.ok ? undefined : "seed-mismatch",
    });

    if (!check.ok) {
      failures.push(check.failure);
    }
  }

  // --- Phase C: baseline green again (idempotent / no tree mutate) ---
  const restore = await runDependencyDirectionGate({
    subjectId: `${subjectId}.after-seed`,
    deviceId,
    emitEvents: false,
  });
  emit({
    outcome: restore.status === 0 ? "ok" : "fail",
    phase: "baseline.green.after-seed",
    subjectId: `${subjectId}.after-seed`,
    deviceId,
    exitCode: restore.status,
    violationCount: restore.violations.length,
  });
  if (restore.status !== 0) {
    failures.push(
      `BASELINE_STILL_RED_AFTER_SEED:\n${(restore.combined ?? "").slice(0, 4000)}`,
    );
  }

  const ok = failures.length === 0;
  const completionRecord = buildCompletionRecord({
    ok,
    seedResults,
    failures,
    subjectId,
    deviceId,
  });

  // Print completion record for the status/completion artifact.
  process.stdout.write(
    `${JSON.stringify({ event: "dependency.direction.prove.record", ...completionRecord })}\n`,
  );

  emit({
    outcome: ok ? "ok" : "fail",
    phase: "prove.complete",
    subjectId,
    deviceId,
    rulesProven: seedResults.filter((s) => s.ok).map((s) => s.ruleId),
  });

  return { ok, completionRecord, failures };
}

function buildCompletionRecord({
  ok,
  seedResults,
  failures,
  subjectId,
  deviceId,
}) {
  return {
    taskId: "TASK-B-B2-DEPEDIRELI-BOUNRULE-002",
    ok,
    subjectId,
    deviceId,
    typeOnlyImportsCountAsEdges: true,
    rules: Object.values(RULE_IDS),
    seeds: seedResults,
    failures,
    messagePolicy: "fail with offending file and violated edge (rule: from → to)",
  };
}

export async function main() {
  const result = await proveDependencyDirectionGate();
  if (!result.ok) {
    for (const f of result.failures) {
      process.stderr.write(`${f}\n`);
    }
    process.exitCode = 1;
    return;
  }
  process.exitCode = 0;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((err) => {
    emit({
      outcome: "error",
      phase: "main",
      subjectId: "subj-deps-prove",
      deviceId: "dev-deps-prove",
      failureClass: "unhandled",
      message: err instanceof Error ? err.message : String(err),
    });
    process.stderr.write(
      `DEPENDENCY_DIRECTION_PROVE_FAILED:${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  });
}
