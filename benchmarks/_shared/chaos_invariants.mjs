/**
 * Post-drill invariant assertion suite (SYNCCHAO-004).
 * Run after every chaos scenario:
 *   - CRDT commutativity spot-check
 *   - Advisory uniqueness per syncAttemptId
 *   - Zero raw learner content in audit / wire payloads
 * Metadata only — distinct failure classes, never silent pass.
 */
import { CrdtHarnessResolver } from "sutra-sdk";
import {
  buildEdgeStateWithPendingSamples,
} from "./sync_convergence_probe.mjs";
import {
  canonicalStateEqual,
  emitSyncChaosTelemetry,
  stableStringify,
} from "./sync_chaos_probe.mjs";

/** Keys / substrings that must never appear in audit or drill result payloads. */
export const FORBIDDEN_CONTENT_MARKERS = Object.freeze([
  "utterance",
  "keystroke",
  "password",
  "ssn",
  "learner essay",
  "secret learner",
]);

/**
 * Spot-check CRDT commutativity: merge(a,b) ≡ merge(b,a) for subject-scoped replicas.
 */
export function assertCrdtCommutativitySpotCheck(opts = {}) {
  const subjectId = opts.subjectId ?? "subj-invariant-comm";
  const deviceA = opts.deviceA ?? "edge-inv-a";
  const deviceB = opts.deviceB ?? "edge-inv-b";
  const sampleCount = opts.sampleCount ?? 6;
  const resolver = opts.resolver ?? new CrdtHarnessResolver();

  if (typeof subjectId !== "string" || !subjectId.trim()) {
    return {
      ok: false,
      failureClass: "validation_failed",
      invariant: "crdt_commutativity",
      detail: "subjectId required",
    };
  }

  const a = buildEdgeStateWithPendingSamples(deviceA, subjectId, sampleCount);
  const b = buildEdgeStateWithPendingSamples(deviceB, subjectId, sampleCount);
  // Diverge friction slightly so merge is non-trivial.
  b.frictionLog = b.frictionLog.map((s, i) => ({
    ...s,
    hesitationMs: s.hesitationMs + 10 + i,
  }));

  const ab = resolver.merge(a, b).merged;
  const ba = resolver.merge(b, a).merged;
  const equal = canonicalStateEqual(ab, ba);

  if (!equal) {
    return {
      ok: false,
      failureClass: "commutativity_breach",
      invariant: "crdt_commutativity",
      subjectId,
      detail: "merge(a,b) !== merge(b,a)",
    };
  }

  // Idempotent spot-check: merge(ab, ab) ≡ ab
  const aa = resolver.merge(ab, ab).merged;
  if (!canonicalStateEqual(ab, aa)) {
    return {
      ok: false,
      failureClass: "idempotence_breach",
      invariant: "crdt_commutativity",
      subjectId,
      detail: "merge(m,m) !== m",
    };
  }

  return {
    ok: true,
    failureClass: null,
    invariant: "crdt_commutativity",
    subjectId,
  };
}

/**
 * Advisories / audit rows: at most one durable audit entry per syncAttemptId;
 * advisory codes within a row must be unique.
 */
export function assertAdvisoryUniquenessPerAttempt(input = {}) {
  const audits = normalizeAudits(input);
  const seenAttempts = new Map();

  for (const row of audits) {
    const attemptId = row.syncAttemptId;
    if (typeof attemptId !== "string" || !attemptId.trim()) {
      return {
        ok: false,
        failureClass: "validation_failed",
        invariant: "advisory_uniqueness",
        detail: "audit row missing syncAttemptId",
      };
    }
    if (seenAttempts.has(attemptId)) {
      return {
        ok: false,
        failureClass: "duplicate_audit_attempt",
        invariant: "advisory_uniqueness",
        syncAttemptId: attemptId,
        subjectId: row.subjectId ?? null,
        detail: "duplicate sync_audit row for syncAttemptId",
      };
    }
    seenAttempts.set(attemptId, row);

    const codes = row.advisoryCodes ?? row.advisories?.map((a) => a.code) ?? [];
    const unique = new Set(codes);
    if (unique.size !== codes.length) {
      return {
        ok: false,
        failureClass: "duplicate_advisory_code",
        invariant: "advisory_uniqueness",
        syncAttemptId: attemptId,
        subjectId: row.subjectId ?? null,
        detail: "duplicate advisory code within one audit row",
      };
    }
  }

  // Optional: outcome.advisoryCodes uniqueness when no audit rows.
  const outcomeCodes = input.outcome?.advisoryCodes;
  if (Array.isArray(outcomeCodes)) {
    const unique = new Set(outcomeCodes);
    if (unique.size !== outcomeCodes.length) {
      return {
        ok: false,
        failureClass: "duplicate_advisory_code",
        invariant: "advisory_uniqueness",
        syncAttemptId: input.syncAttemptId ?? null,
        detail: "duplicate advisoryCodes on outcome",
      };
    }
  }

  return {
    ok: true,
    failureClass: null,
    invariant: "advisory_uniqueness",
    attemptCount: seenAttempts.size,
  };
}

function normalizeAudits(input) {
  if (Array.isArray(input.audits)) return input.audits;
  if (input.transport && typeof input.transport.getAllAudits === "function") {
    const all = input.transport.getAllAudits();
    if (input.subjectId) {
      return all.filter((r) => r.subjectId === input.subjectId);
    }
    return all;
  }
  if (input.transport && typeof input.transport.getAuditLog === "function") {
    return input.transport.getAuditLog(input.subjectId);
  }
  return [];
}

/**
 * Audit / drill payloads must not carry raw learner content markers.
 */
export function assertZeroRawContentInAudit(input = {}) {
  const payloads = [];
  if (input.audits) payloads.push(input.audits);
  if (input.transport?.getAllAudits) payloads.push(input.transport.getAllAudits());
  if (input.outcome) {
    payloads.push({
      status: input.outcome.status,
      advisoryCodes: input.outcome.advisoryCodes,
      attempts: input.outcome.attempts,
    });
  }
  if (input.advisories) payloads.push(input.advisories);
  if (input.turn1) {
    payloads.push({
      effects: input.turn1.effects,
      advisory: input.turn1.advisory,
      subjectId: input.turn1.subjectId,
    });
  }

  const blob = stableStringify(payloads).toLowerCase();
  for (const marker of FORBIDDEN_CONTENT_MARKERS) {
    if (blob.includes(marker.toLowerCase())) {
      return {
        ok: false,
        failureClass: "content_leak",
        invariant: "zero_raw_content",
        detail: `forbidden marker present: ${marker}`,
        subjectId: input.subjectId ?? null,
      };
    }
  }

  // Structural: audit rows must not embed utterance / frictionLog bodies.
  for (const row of normalizeAudits(input)) {
    if (row && typeof row === "object") {
      if ("utterance" in row || "frictionLog" in row || "keystroke" in row) {
        return {
          ok: false,
          failureClass: "content_leak",
          invariant: "zero_raw_content",
          detail: "audit row contains content field",
          subjectId: row.subjectId ?? null,
        };
      }
    }
  }

  return {
    ok: true,
    failureClass: null,
    invariant: "zero_raw_content",
    subjectId: input.subjectId ?? null,
  };
}

/**
 * Run the full post-drill suite against one chaos scenario result.
 */
export function assertPostDrillInvariants(drillResult = {}, opts = {}) {
  const drill = drillResult.drill ?? "unknown";
  const subjectId = drillResult.subjectId ?? opts.subjectId ?? null;
  const checks = [];

  if (drillResult.skipped) {
    return {
      ok: true,
      skipped: true,
      drill,
      subjectId,
      checks: [],
      failureClass: null,
    };
  }

  const comm = assertCrdtCommutativitySpotCheck({
    subjectId: subjectId ?? "subj-post-drill-comm",
    sampleCount: opts.commutativitySamples ?? 4,
  });
  checks.push(comm);

  const uniq = assertAdvisoryUniquenessPerAttempt(drillResult);
  checks.push(uniq);

  const sov = assertZeroRawContentInAudit(drillResult);
  checks.push(sov);

  // Scenario-specific: replica equality / apply ≤ 1 when reported.
  if (drillResult.replicasEqual === false) {
    checks.push({
      ok: false,
      failureClass: "replica_divergence",
      invariant: "replica_equality",
      subjectId,
    });
  } else if (drillResult.replicasEqual === true) {
    checks.push({
      ok: true,
      failureClass: null,
      invariant: "replica_equality",
      subjectId,
    });
  }

  if (
    typeof drillResult.applyCount === "number" &&
    drillResult.applyCount > 1
  ) {
    checks.push({
      ok: false,
      failureClass: "double_apply",
      invariant: "idempotent_apply",
      subjectId,
      applyCount: drillResult.applyCount,
    });
  }

  const breaches = checks.filter((c) => !c.ok);
  const ok = breaches.length === 0 && drillResult.ok !== false;

  const failureClass = !ok
    ? breaches[0]?.failureClass ??
      (drillResult.ok === false ? drillResult.failureClass : "invariant_breach")
    : null;

  return {
    ok: ok && drillResult.ok !== false,
    skipped: false,
    drill,
    subjectId,
    deviceId: drillResult.deviceId ?? null,
    syncAttemptId: drillResult.syncAttemptId ?? null,
    checks,
    breachCount: breaches.length,
    failureClass,
  };
}

/**
 * Assert invariants after every chaos scenario; emit structured summary.
 */
export function runPostDrillInvariantSuite(drillResults = [], opts = {}) {
  if (!Array.isArray(drillResults)) {
    return {
      ok: false,
      failureClass: "validation_failed",
      detail: "drillResults must be an array",
      rows: [],
    };
  }

  const rows = drillResults.map((r) => assertPostDrillInvariants(r, opts));
  const hard = rows.filter((r) => !r.skipped && !r.ok);
  const ok = hard.length === 0;

  emitSyncChaosTelemetry({
    outcome: ok ? "ok" : "rejected",
    action: "post_drill_invariants",
    failureClass: ok ? null : hard[0]?.failureClass ?? "invariant_breach",
    drillCount: drillResults.length,
    breachCount: hard.length,
    subjectId: null,
    deviceId: opts.deviceId ?? "edge-chaos-invariants",
  });

  return {
    ok,
    failureClass: ok ? null : hard[0]?.failureClass ?? "invariant_breach",
    rows,
    breachCount: hard.length,
  };
}

export function formatPostDrillInvariantReport(suite) {
  const lines = ["---- sync chaos: post-drill invariants ----"];
  for (const row of suite.rows ?? []) {
    if (row.skipped) {
      lines.push(`SKIP ${row.drill}`);
      continue;
    }
    const mark = row.ok ? "PASS" : "FAIL";
    lines.push(
      `${mark} ${row.drill} checks=${row.checks?.length ?? 0} breaches=${row.breachCount ?? 0}` +
        (row.failureClass ? ` class=${row.failureClass}` : ""),
    );
    for (const c of row.checks ?? []) {
      if (!c.ok) {
        lines.push(
          `  - ${c.invariant}: ${c.failureClass} ${c.detail ?? ""}`.trimEnd(),
        );
      }
    }
  }
  lines.push(suite.ok ? "SUITE PASS" : "SUITE FAIL");
  lines.push("------------------------------------------");
  return `${lines.join("\n")}\n`;
}
