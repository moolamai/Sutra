/**
 * External security review scope gate (SEC-01 — commissioning slice).
 *
 * Asserts security/EXTERNAL-REVIEW.md records a review scope whose code and
 * regression anchors resolve to existing files, covers all four surfaces
 * (protocol, auth, sandbox, sync), states the five independence rules, and
 * keeps the P0/P1 freeze-RFC blocking policy and findings register intact.
 *
 * Usage (repo root):
 *   node scripts/check-external-review.mjs
 *   pnpm external-review:check
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");
export const EXTERNAL_REVIEW = path.join(
  REPO_ROOT,
  "security",
  "EXTERNAL-REVIEW.md",
);

export const OBLIGATIONS = Object.freeze({
  MISSING_DOC: "external_review.scope.missing_doc",
  MISSING_SECTION: "external_review.scope.missing_section",
  MISSING_SURFACE: "external_review.scope.missing_surface",
  BROKEN_CODE_ANCHOR: "external_review.scope.broken_code_anchor",
  SURFACE_WITHOUT_ANCHOR: "external_review.scope.surface_without_anchor",
  MISSING_INDEPENDENCE_RULE: "external_review.scope.missing_independence_rule",
  MISSING_SEVERITY_POLICY: "external_review.scope.missing_severity_policy",
  MISSING_REGISTER: "external_review.scope.missing_register",
  CVE_ONLY_SCOPE: "external_review.scope.cve_only_scope",
  SOVEREIGNTY: "external_review.scope.sovereignty_incomplete",
  // Triage-closure obligations (EXTEREVI-002).
  NO_FINDINGS_FILED: "external_review.triage.no_findings_filed",
  OPEN_P0P1_FINDING: "external_review.triage.open_p0p1_finding",
  FINDING_WITHOUT_EVIDENCE: "external_review.triage.finding_without_evidence",
  BROKEN_EVIDENCE_LINK: "external_review.triage.broken_evidence_link",
  MISSING_CLOSURE_CHECKLIST: "external_review.triage.missing_closure_checklist",
});

/** Review surfaces the engagement must scope (R1..R4). */
export const REQUIRED_SURFACES = Object.freeze([
  "protocol",
  "auth",
  "sandbox",
  "sync",
]);

export const REQUIRED_SECTIONS = Object.freeze([
  "## Engagement record",
  "## Review scope",
  "## Independence rules",
  "## Methodology",
  "## Severity policy",
  "## Findings register",
]);

/**
 * Substrings that must each appear in the independence rules block — one per
 * binding rule, so a dropped rule fails with its name.
 */
export const REQUIRED_INDEPENDENCE_RULES = Object.freeze([
  ["no_self_review", /must not have authored/i],
  ["fresh_clone", /fresh clone/i],
  ["attack_before_defense", /before\W+reading the mitigation/i],
  ["independent_reporting", /never triaged or downgraded by the code's author/i],
  ["named_signoff", /named reviewer and date/i],
]);

const CODE_ANCHOR_RE = /`(packages\/[^`]+\.(?:ts|py|mjs))`/g;

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "external_review.scope.check", ...event })}\n`,
  );
}

/**
 * Extract the block for one `### Surface Rn — … (\`id\`)` heading.
 * @param {string} body
 * @param {string} surfaceId
 */
export function surfaceBlock(body, surfaceId) {
  const re = new RegExp(
    `### Surface R\\d+[^\\n]*\\(\`${surfaceId}\`\\)([\\s\\S]*?)(?=### Surface R\\d+|## )`,
  );
  return re.exec(body)?.[1] ?? "";
}

/**
 * All backticked packages/* code + test anchors in a block.
 * @param {string} block
 */
export function codeAnchors(block) {
  return [...block.matchAll(CODE_ANCHOR_RE)].map((m) => m[1]);
}

/**
 * Parse the findings register table rows into structured findings.
 * @param {string} body
 * @returns {{ id: string, severity: string, status: string, evidence: string }[]}
 */
export function parseFindings(body) {
  const register =
    /## Findings register([\s\S]*?)(?=### Finding detail|## Closure checklist|## Correlation|$)/.exec(
      body,
    )?.[1] ?? "";
  /** @type {{ id: string, severity: string, status: string, evidence: string }[]} */
  const findings = [];
  for (const line of register.split(/\r?\n/)) {
    if (!line.startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 6) continue;
    const id = /`(F-EXT-[0-9]+)`/.exec(cells[0])?.[1];
    if (!id) continue;
    const severity = (/P[0-3]/.exec(cells[2])?.[0] ?? "").toUpperCase();
    const status = cells[3].replace(/`/g, "").trim().toLowerCase();
    const evidence = /`([^`]+)`/.exec(cells[5])?.[1] ?? "";
    findings.push({ id, severity, status, evidence });
  }
  return findings;
}

/**
 * @param {{ reviewPath?: string, repoRoot?: string }} [opts]
 * @returns {{ ok: boolean, failures: string[], surfaces: number, anchors: number }}
 */
export function checkExternalReview(opts = {}) {
  const reviewPath = opts.reviewPath ?? EXTERNAL_REVIEW;
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  /** @type {string[]} */
  const failures = [];

  if (!existsSync(reviewPath)) {
    failures.push(`${OBLIGATIONS.MISSING_DOC}:${reviewPath}`);
    return { ok: false, failures, surfaces: 0, anchors: 0 };
  }

  const body = readFileSync(reviewPath, "utf8");

  for (const section of REQUIRED_SECTIONS) {
    if (!body.includes(section)) {
      failures.push(`${OBLIGATIONS.MISSING_SECTION}:${section}`);
    }
  }

  let surfaces = 0;
  let anchors = 0;
  for (const surfaceId of REQUIRED_SURFACES) {
    const block = surfaceBlock(body, surfaceId);
    if (!block.trim()) {
      failures.push(`${OBLIGATIONS.MISSING_SURFACE}:${surfaceId}`);
      continue;
    }
    surfaces += 1;
    const found = codeAnchors(block);
    if (found.length === 0) {
      failures.push(`${OBLIGATIONS.SURFACE_WITHOUT_ANCHOR}:${surfaceId}`);
      continue;
    }
    for (const anchor of found) {
      anchors += 1;
      const abs = path.join(repoRoot, anchor.replace(/\//g, path.sep));
      if (!existsSync(abs)) {
        failures.push(
          `${OBLIGATIONS.BROKEN_CODE_ANCHOR}:${surfaceId}:${anchor}`,
        );
      }
    }
  }

  const independence =
    /## Independence rules([\s\S]*?)(?=## )/.exec(body)?.[1] ?? "";
  for (const [ruleId, re] of REQUIRED_INDEPENDENCE_RULES) {
    if (!re.test(independence)) {
      failures.push(`${OBLIGATIONS.MISSING_INDEPENDENCE_RULE}:${ruleId}`);
    }
  }

  const severity = /## Severity policy([\s\S]*?)(?=## )/.exec(body)?.[1] ?? "";
  if (
    !/P0/.test(severity) ||
    !/P1/.test(severity) ||
    !/[Bb]locks? freeze RFC/.test(severity)
  ) {
    failures.push(OBLIGATIONS.MISSING_SEVERITY_POLICY);
  }

  const register =
    /## Findings register([\s\S]*?)(?=## |$)/.exec(body)?.[1] ?? "";
  if (
    !/\| Finding ID \|/.test(register) ||
    !/Severity/.test(register) ||
    !/Owner/.test(register) ||
    !/Re-test evidence/.test(register)
  ) {
    failures.push(OBLIGATIONS.MISSING_REGISTER);
  }

  // The review must target implementation flaws, not just dependency CVEs.
  if (
    !/protocol parsing|parse boundaries|parser/i.test(body) ||
    !/auth bypass/i.test(body) ||
    !/sandbox escape/i.test(body) ||
    !/not just dependency CVEs|not the review/i.test(body)
  ) {
    failures.push(OBLIGATIONS.CVE_ONLY_SCOPE);
  }

  // Sovereignty: review fixtures are synthetic; evidence carries metadata only.
  if (
    !/synthetic subjects/i.test(body) ||
    !/subjectId/.test(body) ||
    !/never raw utterances|no real learner content/i.test(body)
  ) {
    failures.push(OBLIGATIONS.SOVEREIGNTY);
  }

  // --- Triage closure (EXTEREVI-002) ---
  if (!/## Closure checklist/.test(body)) {
    failures.push(OBLIGATIONS.MISSING_CLOSURE_CHECKLIST);
  }

  const findings = parseFindings(body);
  if (findings.length === 0) {
    failures.push(OBLIGATIONS.NO_FINDINGS_FILED);
  }
  for (const finding of findings) {
    const isBlocking = finding.severity === "P0" || finding.severity === "P1";
    if (isBlocking && finding.status !== "closed") {
      failures.push(
        `${OBLIGATIONS.OPEN_P0P1_FINDING}:${finding.id}:${finding.severity}:${finding.status}`,
      );
      continue;
    }
    // A closed finding must carry re-test evidence resolving to a repo file;
    // accepted (P2/P3) findings point at a residual-risk entry instead.
    if (finding.status === "closed") {
      if (!/^(?:packages|scripts)\//.test(finding.evidence)) {
        failures.push(
          `${OBLIGATIONS.FINDING_WITHOUT_EVIDENCE}:${finding.id}`,
        );
        continue;
      }
      const abs = path.join(
        repoRoot,
        finding.evidence.replace(/\//g, path.sep),
      );
      if (!existsSync(abs)) {
        failures.push(
          `${OBLIGATIONS.BROKEN_EVIDENCE_LINK}:${finding.id}:${finding.evidence}`,
        );
      }
    }
  }

  const ok = failures.length === 0;
  return { ok, failures, surfaces, anchors, findings: findings.length };
}

function main() {
  const result = checkExternalReview();
  emit({
    outcome: result.ok ? "ok" : "fail",
    surfaces: result.surfaces,
    anchors: result.anchors,
    findings: result.findings ?? 0,
    failureCount: result.failures.length,
  });
  if (!result.ok) {
    for (const f of result.failures) {
      process.stderr.write(`${f}\n`);
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
