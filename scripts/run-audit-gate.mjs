/**
 * Dependency audit gate (SEC-02 — pnpm audit + pip-audit with triage).
 *
 * Runs pnpm audit on the lockfile and pip-audit on cloud-orchestrator.
 * Critical and high findings block merge unless listed in
 * security/AUDIT-SUPPRESSIONS.json with a future expiryOn and owner.
 * Expired suppressions fail CI. Failures print offending advisory IDs.
 *
 * Usage (repo root):
 *   node scripts/run-audit-gate.mjs
 *   pnpm audit:gate
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");
export const SUPPRESSIONS_PATH = path.join(
  REPO_ROOT,
  "security",
  "AUDIT-SUPPRESSIONS.json",
);
export const CLOUD_ORCHESTRATOR = path.join(
  REPO_ROOT,
  "packages",
  "cloud-orchestrator",
);

export const BLOCKING_SEVERITIES = new Set(["critical", "high"]);

export const OBLIGATIONS = Object.freeze({
  MISSING_SUPPRESSIONS: "audit_gate.missing_suppressions",
  INVALID_SUPPRESSIONS: "audit_gate.invalid_suppressions",
  EXPIRED_SUPPRESSION: "audit_gate.expired_suppression",
  PNPM_AUDIT_FAILED: "audit_gate.pnpm_audit_failed",
  PIP_AUDIT_FAILED: "audit_gate.pip_audit_failed",
  UNSUPPRESSED_FINDING: "audit_gate.unsuppressed_finding",
});

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "audit_gate.check", ...event })}\n`,
  );
}

/**
 * @param {string} isoDate YYYY-MM-DD
 */
export function isExpired(isoDate, now = new Date()) {
  const end = new Date(`${isoDate}T23:59:59.999Z`);
  return Number.isNaN(end.getTime()) || end < now;
}

/**
 * @param {unknown} raw
 */
export function validateSuppressions(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error(`${OBLIGATIONS.INVALID_SUPPRESSIONS}:not_an_object`);
  }
  const doc = /** @type {Record<string, unknown>} */ (raw);
  if (doc.schemaVersion !== 1) {
    throw new Error(`${OBLIGATIONS.INVALID_SUPPRESSIONS}:schema_version`);
  }
  if (!Array.isArray(doc.suppressions)) {
    throw new Error(`${OBLIGATIONS.INVALID_SUPPRESSIONS}:suppressions_array`);
  }
  /** @type {import('./run-audit-gate.mjs').Suppression[]} */
  const suppressions = [];
  for (const [i, row] of doc.suppressions.entries()) {
    if (!row || typeof row !== "object") {
      throw new Error(`${OBLIGATIONS.INVALID_SUPPRESSIONS}:row_${i}`);
    }
    const s = /** @type {Record<string, unknown>} */ (row);
    const advisoryIds = s.advisoryIds;
    if (!Array.isArray(advisoryIds) || advisoryIds.length === 0) {
      throw new Error(`${OBLIGATIONS.INVALID_SUPPRESSIONS}:advisory_ids_${i}`);
    }
    for (const field of [
      "ecosystem",
      "package",
      "severity",
      "owner",
      "expiresOn",
      "rationale",
    ]) {
      if (typeof s[field] !== "string" || !String(s[field]).trim()) {
        throw new Error(`${OBLIGATIONS.INVALID_SUPPRESSIONS}:${field}_${i}`);
      }
    }
    if (String(s.rationale).trim().length < 20) {
      throw new Error(`${OBLIGATIONS.INVALID_SUPPRESSIONS}:rationale_short_${i}`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s.expiresOn))) {
      throw new Error(`${OBLIGATIONS.INVALID_SUPPRESSIONS}:expires_on_${i}`);
    }
    suppressions.push({
      advisoryIds: advisoryIds.map(String),
      ecosystem: String(s.ecosystem),
      package: String(s.package),
      severity: String(s.severity).toLowerCase(),
      owner: String(s.owner),
      expiresOn: String(s.expiresOn),
      rationale: String(s.rationale),
    });
  }
  return suppressions;
}

/**
 * @param {string} suppressionsPath
 * @param {Date} [now]
 */
export function loadSuppressions(suppressionsPath = SUPPRESSIONS_PATH, now = new Date()) {
  if (!existsSync(suppressionsPath)) {
    throw new Error(`${OBLIGATIONS.MISSING_SUPPRESSIONS}:${suppressionsPath}`);
  }
  const suppressions = validateSuppressions(
    JSON.parse(readFileSync(suppressionsPath, "utf8")),
  );
  /** @type {string[]} */
  const expired = [];
  for (const s of suppressions) {
    if (isExpired(s.expiresOn, now)) {
      expired.push(`${s.advisoryIds[0]}:${s.expiresOn}`);
    }
  }
  if (expired.length > 0) {
    throw new Error(
      `${OBLIGATIONS.EXPIRED_SUPPRESSION}:${expired.join(",")}`,
    );
  }
  return suppressions;
}

/**
 * @typedef {{ ecosystem: 'npm'|'pip', package: string, severity: string, advisoryIds: string[], title?: string }} AuditFinding
 * @typedef {{ advisoryIds: string[], ecosystem: string, package: string, severity: string, owner: string, expiresOn: string, rationale: string }} Suppression
 */

/**
 * @param {string} auditJson
 * @returns {AuditFinding[]}
 */
export function parsePnpmAudit(auditJson) {
  const data = JSON.parse(auditJson);
  /** @type {AuditFinding[]} */
  const findings = [];
  for (const advisory of Object.values(data.advisories ?? {})) {
    const a = /** @type {Record<string, unknown>} */ (advisory);
    const severity = String(a.severity ?? "").toLowerCase();
    if (!BLOCKING_SEVERITIES.has(severity)) continue;
    /** @type {string[]} */
    const ids = [String(a.id ?? "")];
    if (a.github_advisory_id) ids.push(String(a.github_advisory_id));
    if (Array.isArray(a.cves)) ids.push(...a.cves.map(String));
    findings.push({
      ecosystem: "npm",
      package: String(a.module_name ?? ""),
      severity,
      advisoryIds: [...new Set(ids.filter(Boolean))],
      title: String(a.title ?? ""),
    });
  }
  return findings;
}

/**
 * @param {string} auditJson
 * @returns {AuditFinding[]}
 */
export function parsePipAudit(auditJson) {
  const data = JSON.parse(auditJson);
  /** @type {AuditFinding[]} */
  const findings = [];
  for (const dep of data.dependencies ?? []) {
    const d = /** @type {Record<string, unknown>} */ (dep);
    for (const vuln of d.vulns ?? []) {
      const v = /** @type {Record<string, unknown>} */ (vuln);
      const severity = String(v.severity ?? v.fix_versions ? "unknown" : "")
        .toLowerCase();
      const aliases = Array.isArray(v.aliases) ? v.aliases.map(String) : [];
      const ids = [...aliases];
      if (v.id) ids.push(String(v.id));
      const filed =
        severity && severity !== "unknown"
          ? severity
          : aliases.length > 0
            ? "high"
            : "moderate";
      if (!BLOCKING_SEVERITIES.has(filed)) continue;
      findings.push({
        ecosystem: "pip",
        package: String(d.name ?? ""),
        severity: filed,
        advisoryIds: [...new Set(ids.filter(Boolean))],
        title: String(v.description ?? v.id ?? ""),
      });
    }
  }
  return findings;
}

/**
 * pip-audit severity is not always present; map known critical aliases conservatively.
 * @param {AuditFinding} finding
 */
export function normalizePipSeverity(finding) {
  if (finding.severity !== "unknown") return finding;
  return { ...finding, severity: "high" };
}

/**
 * @param {AuditFinding} finding
 * @param {Suppression[]} suppressions
 */
export function isSuppressed(finding, suppressions) {
  return suppressions.some((s) => {
    if (s.ecosystem !== finding.ecosystem) return false;
    if (s.package !== finding.package) return false;
    return finding.advisoryIds.some((id) => s.advisoryIds.includes(id));
  });
}

/**
 * @param {AuditFinding[]} findings
 * @param {Suppression[]} suppressions
 */
export function filterUnsuppressed(findings, suppressions) {
  return findings.filter((f) => !isSuppressed(f, suppressions));
}

/**
 * @param {AuditFinding} finding
 */
export function formatFindingLine(finding) {
  return [
    `AUDIT FAIL ${finding.ecosystem}`,
    `package=${finding.package}`,
    `severity=${finding.severity}`,
    `advisoryIds=${finding.advisoryIds.join(",")}`,
    finding.title ? `title=${finding.title}` : "",
  ]
    .filter(Boolean)
    .join(" | ");
}

/**
 * @param {{
 *   repoRoot?: string,
 *   suppressionsPath?: string,
 *   runPnpm?: () => { status: number, stdout: string, stderr: string },
 *   runPip?: () => { status: number, stdout: string, stderr: string },
 *   now?: Date,
 *   subjectId?: string,
 *   deviceId?: string,
 * }} [opts]
 */
export function runAuditGate(opts = {}) {
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const suppressionsPath = opts.suppressionsPath ?? SUPPRESSIONS_PATH;
  const subjectId = opts.subjectId ?? "ci-audit-gate";
  const deviceId = opts.deviceId ?? "ci";
  /** @type {string[]} */
  const failures = [];

  let suppressions;
  try {
    suppressions = loadSuppressions(suppressionsPath, opts.now);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failures.push(message);
    emit({
      outcome: "fail",
      subjectId,
      deviceId,
      phase: "suppressions",
      failureCount: failures.length,
    });
    return { ok: false, failures, npm: 0, pip: 0, blocking: 0 };
  }

  const runPnpm =
    opts.runPnpm ??
    (() =>
      spawnSync("pnpm", ["audit", "--json"], {
        cwd: repoRoot,
        encoding: "utf8",
        shell: process.platform === "win32",
        env: process.env,
      }));

  const pnpm = runPnpm();
  if (pnpm.status !== 0 && !pnpm.stdout?.trim()) {
    failures.push(
      `${OBLIGATIONS.PNPM_AUDIT_FAILED}:exit=${pnpm.status}:${pnpm.stderr?.slice(0, 500)}`,
    );
  }

  let npmFindings = [];
  try {
    npmFindings = parsePnpmAudit(pnpm.stdout || "{}");
  } catch (err) {
    failures.push(
      `${OBLIGATIONS.PNPM_AUDIT_FAILED}:parse:${err instanceof Error ? err.message : err}`,
    );
  }

  const runPip =
    opts.runPip ??
    (() =>
      spawnSync(
        "pip-audit",
        [path.join(repoRoot, "packages", "cloud-orchestrator"), "-f", "json"],
        {
          cwd: repoRoot,
          encoding: "utf8",
          shell: process.platform === "win32",
          env: process.env,
        },
      ));

  const pip = runPip();
  if (pip.status !== 0 && !pip.stdout?.trim()) {
    failures.push(
      `${OBLIGATIONS.PIP_AUDIT_FAILED}:exit=${pip.status}:${pip.stderr?.slice(0, 500)}`,
    );
  }

  let pipFindings = [];
  try {
    const text = (pip.stdout || "{}").trim();
    const jsonStart = text.indexOf("{");
    pipFindings = parsePipAudit(jsonStart >= 0 ? text.slice(jsonStart) : "{}");
  } catch (err) {
    failures.push(
      `${OBLIGATIONS.PIP_AUDIT_FAILED}:parse:${err instanceof Error ? err.message : err}`,
    );
  }

  const allFindings = [...npmFindings, ...pipFindings.map(normalizePipSeverity)];
  const blocking = filterUnsuppressed(allFindings, suppressions);

  for (const finding of blocking) {
    failures.push(
      `${OBLIGATIONS.UNSUPPRESSED_FINDING}:${finding.advisoryIds.join("|")}`,
    );
  }

  const ok = failures.length === 0;
  emit({
    outcome: ok ? "ok" : "fail",
    subjectId,
    deviceId,
    npmFindings: npmFindings.length,
    pipFindings: pipFindings.length,
    blocking: blocking.length,
    suppressed: allFindings.length - blocking.length,
    failureCount: failures.length,
  });

  return {
    ok,
    failures,
    npm: npmFindings.length,
    pip: pipFindings.length,
    blocking,
    allFindings,
    failureLines: blocking.map(formatFindingLine),
  };
}

function main() {
  const result = runAuditGate();
  if (!result.ok) {
    for (const line of result.failureLines ?? []) {
      process.stderr.write(`${line}\n`);
    }
    for (const f of result.failures) {
      if (!result.failureLines?.some((l) => l.includes(f))) {
        process.stderr.write(`${f}\n`);
      }
    }
    process.exit(1);
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isMain) {
  main();
}
