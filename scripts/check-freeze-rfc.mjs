/**
 * Protocol 1.0 freeze RFC draft gate (DIST-01 / DIST-02).
 *
 * Ensures the draft lists every public wire interface with numeric evidence
 * coverage, cites executable tests and field-pilot evidence, states the
 * additive-only policy, and gives every open issue an explicit disposition.
 * An Accepted RFC may not retain pending sign-off or blocking issues.
 *
 * Usage:
 *   node scripts/check-freeze-rfc.mjs
 *   pnpm freeze-rfc:check
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");
export const RFC_PATH = path.join(
  REPO_ROOT,
  "rfcs",
  "0001-protocol-1.0-freeze.md",
);

export const OBLIGATIONS = Object.freeze({
  MISSING_RFC: "freeze_rfc.missing_rfc",
  MISSING_SECTION: "freeze_rfc.missing_section",
  MISSING_INTERFACE: "freeze_rfc.missing_interface",
  INVALID_COVERAGE: "freeze_rfc.invalid_coverage",
  BROKEN_EVIDENCE: "freeze_rfc.broken_evidence",
  SILENT_DEFERRAL: "freeze_rfc.silent_deferral",
  MISSING_PILOT: "freeze_rfc.missing_pilot_evidence",
  MISSING_ADDITIVE_POLICY: "freeze_rfc.missing_additive_policy",
  MISSING_SIGNOFF: "freeze_rfc.missing_signoff",
  ACCEPTED_WITH_BLOCKER: "freeze_rfc.accepted_with_blocker",
  SOVEREIGNTY: "freeze_rfc.sovereignty_incomplete",
});

export const REQUIRED_SECTIONS = Object.freeze([
  "## Scope",
  "## Additive-only policy after acceptance",
  "## Evidence appendix",
  "### Public wire interfaces",
  "### Field-pilot evidence",
  "## Open issue disposition",
  "## Acceptance criteria",
]);

export const REQUIRED_WIRE_INTERFACES = Object.freeze([
  "Sync request/response",
  "Harness frame union",
  "Tool-call envelope",
  "Metering event contract",
  "Degradation registry",
]);

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "freeze_rfc.check", ...event })}\n`,
  );
}

/**
 * Parse rows in the public wire interface table.
 * @param {string} body
 */
export function parseWireCoverage(body) {
  const block =
    /### Public wire interfaces([\s\S]*?)(?=### )/.exec(body)?.[1] ?? "";
  /** @type {{ name: string, declared: number, covered: number, percentage: number, evidence: string }[]} */
  const rows = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line.startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 5) continue;
    const declared = Number(cells[1]);
    const covered = Number(cells[2]);
    const percentage = Number(/(\d+(?:\.\d+)?)%/.exec(cells[3])?.[1]);
    if (
      !Number.isFinite(declared) ||
      !Number.isFinite(covered) ||
      !Number.isFinite(percentage)
    ) {
      continue;
    }
    rows.push({
      name: cells[0],
      declared,
      covered,
      percentage,
      evidence: cells[4],
    });
  }
  return rows;
}

/**
 * Extract repo-root test paths from backticks.
 * @param {string} body
 */
export function evidencePaths(body) {
  return [
    ...body.matchAll(
      /`((?:packages|scripts)\/[^`]+\.(?:test\.mjs|test\.ts|py))`/g,
    ),
  ].map((m) => m[1]);
}

/**
 * @param {{ rfcPath?: string, repoRoot?: string }} [opts]
 */
export function checkFreezeRfc(opts = {}) {
  const rfcPath = opts.rfcPath ?? RFC_PATH;
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  /** @type {string[]} */
  const failures = [];

  if (!existsSync(rfcPath)) {
    failures.push(`${OBLIGATIONS.MISSING_RFC}:${rfcPath}`);
    return { ok: false, failures, interfaces: 0, evidencePaths: 0 };
  }

  const body = readFileSync(rfcPath, "utf8");
  for (const section of REQUIRED_SECTIONS) {
    if (!body.includes(section)) {
      failures.push(`${OBLIGATIONS.MISSING_SECTION}:${section}`);
    }
  }

  const rows = parseWireCoverage(body);
  for (const required of REQUIRED_WIRE_INTERFACES) {
    const row = rows.find((r) => r.name.includes(required));
    if (!row) {
      failures.push(`${OBLIGATIONS.MISSING_INTERFACE}:${required}`);
      continue;
    }
    const computed = (row.covered / row.declared) * 100;
    if (
      row.declared <= 0 ||
      row.covered < 0 ||
      row.covered > row.declared ||
      Math.abs(computed - row.percentage) > 0.01
    ) {
      failures.push(
        `${OBLIGATIONS.INVALID_COVERAGE}:${required}:declared=${row.declared}:covered=${row.covered}:stated=${row.percentage}`,
      );
    }
    if (!/\.test\.mjs|\.test\.ts/.test(row.evidence)) {
      failures.push(`${OBLIGATIONS.BROKEN_EVIDENCE}:${required}:no_test`);
    }
  }

  const paths = evidencePaths(body);
  for (const rel of paths) {
    const abs = path.join(repoRoot, rel.replace(/\//g, path.sep));
    if (!existsSync(abs)) {
      failures.push(`${OBLIGATIONS.BROKEN_EVIDENCE}:${rel}`);
    }
  }

  if (
    !/docs\/pilot\/PILOT-SUMMARY\.md/.test(body) ||
    !/docs\/pilot\/PILOT-EXIT-REVIEW\.md/.test(body) ||
    !/FP-002/.test(body)
  ) {
    failures.push(OBLIGATIONS.MISSING_PILOT);
  }

  if (
    !/additive-only/i.test(body) ||
    !/MUST NOT.*removed|must not.*removed/i.test(body) ||
    !/new major version/i.test(body) ||
    !/obligation IDs are append-only/i.test(body)
  ) {
    failures.push(OBLIGATIONS.MISSING_ADDITIVE_POLICY);
  }

  const issueBlock =
    /## Open issue disposition([\s\S]*?)(?=## Acceptance criteria)/.exec(
      body,
    )?.[1] ?? "";
  const status = /\|\s*\*\*Status\*\*\s*\|\s*([^|]+)\|/.exec(body)?.[1]?.trim();
  const signoff =
    /\|\s*\*\*Maintainer acceptance\*\*\s*\|\s*([^|]+)\|/.exec(body)?.[1]?.trim();
  const accepted = /^Accepted\b/i.test(status ?? "");

  if (
    !/closed|Accepted residual/i.test(issueBlock) ||
    !/Waived.*\d{4}-\d{2}-\d{2}|Waived[\s\S]*\d{4}-\d{2}-\d{2}/i.test(
      issueBlock,
    )
  ) {
    failures.push(OBLIGATIONS.SILENT_DEFERRAL);
  }
  // Draft RFCs must still name any blocking row; Accepted RFCs must not.
  if (!accepted && !/Blocks acceptance/i.test(issueBlock)) {
    failures.push(OBLIGATIONS.SILENT_DEFERRAL);
  }

  if (!status || !signoff) {
    failures.push(OBLIGATIONS.MISSING_SIGNOFF);
  }
  if (accepted && /pending/i.test(signoff ?? "")) {
    failures.push(OBLIGATIONS.MISSING_SIGNOFF);
  }
  if (accepted && /Blocks acceptance/i.test(issueBlock)) {
    // Only Status-column blockers count — prose may mention the disposition vocabulary.
    const blockingRows = issueBlock.split(/\r?\n/).filter((line) => {
      if (!line.startsWith("|")) return false;
      if (/^\|\s*-+/.test(line) || /^\|\s*Issue\s*\|/i.test(line)) return false;
      const cells = line
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim());
      return cells.some(
        (c) =>
          /^\*\*Blocks acceptance\*\*$/i.test(c) ||
          /^Blocks acceptance$/i.test(c),
      );
    });
    if (blockingRows.length > 0) {
      failures.push(OBLIGATIONS.ACCEPTED_WITH_BLOCKER);
    }
  }

  if (
    !/subjectId/.test(body) ||
    !/deviceId/.test(body) ||
    !/never raw learner|never raw learner utterances|never raw learner content/i.test(
      body,
    ) ||
    !/outcome/.test(body)
  ) {
    failures.push(OBLIGATIONS.SOVEREIGNTY);
  }

  const ok = failures.length === 0;
  return {
    ok,
    failures,
    interfaces: rows.length,
    evidencePaths: paths.length,
    status,
  };
}

function main() {
  const result = checkFreezeRfc();
  emit({
    outcome: result.ok ? "ok" : "fail",
    subjectId: "ci-freeze-rfc",
    deviceId: "ci",
    status: result.status ?? "missing",
    interfaces: result.interfaces,
    evidencePaths: result.evidencePaths,
    failureCount: result.failures.length,
  });
  if (!result.ok) {
    for (const f of result.failures) process.stderr.write(`${f}\n`);
    process.exit(1);
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isMain) main();
