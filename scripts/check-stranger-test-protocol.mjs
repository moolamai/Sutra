/**
 * Gate for stranger-test protocol + executed findings (STRATEST-001).
 *
 * Usage (repo root):
 *   node scripts/check-stranger-test-protocol.mjs
 *   pnpm stranger-test:check
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");

export const STRANGER_DIR = path.join(REPO_ROOT, "docs", "sdk", "stranger-test");

export const PROTOCOL_PATH = path.join(STRANGER_DIR, "PROTOCOL.md");
export const SITE_LANDING = path.join(
  REPO_ROOT,
  "docs-site",
  "src",
  "quickstarts",
  "stranger-test.md",
);

export const OBLIGATIONS = Object.freeze({
  MISSING_PROTOCOL: "docs_site.stranger.missing_protocol",
  MISSING_FINDINGS: "docs_site.stranger.missing_findings",
  MISSING_SITE_LANDING: "docs_site.stranger.missing_site_landing",
  MISSING_SECTION: "docs_site.stranger.missing_section",
  MISSING_FRICTION: "docs_site.stranger.missing_friction",
  WAIVED_WITHOUT_DEFER: "docs_site.stranger.waived_without_defer",
  SOVEREIGNTY: "docs_site.stranger.sovereignty",
});

const PROTOCOL_PATTERNS = Object.freeze([
  { id: "timebox", re: /8 hours|≤ 8 h|one calendar day/i },
  { id: "no-monorepo", re: /no monorepo|without.*monorepo/i },
  { id: "no-slack", re: /no Slack|without.*Slack/i },
  { id: "success-criteria", re: /Success criteria|smoke/i },
  { id: "recording-template", re: /Recording template|Friction log/i },
  { id: "severity-brief", re: /Tester brief/i },
  { id: "severity-only", re: /Observe only|no coaching/i },
  { id: "severity-severity", re: /subjectId/ },
  { id: "idempotent", re: /idempotent|syncAttemptId/i },
  { id: "restart", re: /[Rr]estart/ },
]);

const FINDINGS_PATTERNS = Object.freeze([
  { id: "wall-clock", re: /Active wall-clock|wall-clock/i },
  { id: "outcome", re: /Outcome.*pass|outcome.: .pass/i },
  { id: "friction-table", re: /Friction log|F-00\d/ },
  { id: "severity", re: /subjectId/ },
  { id: "session-event", re: /docs_site\.stranger_test/ },
  { id: "severityignty", re: /no raw learner|utterance body/i },
]);

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "docs_site.stranger_test.check", ...event })}\n`,
  );
}

export function listFindingsFiles(dir = STRANGER_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^FINDINGS-\d{4}-\d{2}-\d{2}\.md$/u.test(name))
    .sort();
}

export function validateStrangerTestProtocol(opts = {}) {
  const protocolPath = opts.protocolPath ?? PROTOCOL_PATH;
  const findingsDir = opts.findingsDir ?? STRANGER_DIR;
  const siteLandingPath = opts.siteLandingPath ?? SITE_LANDING;
  const violations = [];

  if (!existsSync(protocolPath)) {
    violations.push({
      obligation: OBLIGATIONS.MISSING_PROTOCOL,
      detail: "PROTOCOL.md is required",
    });
    return { status: 1, violations };
  }

  const protocol = readFileSync(protocolPath, "utf8");
  for (const pattern of PROTOCOL_PATTERNS) {
    if (!pattern.re.test(protocol)) {
      violations.push({
        obligation: OBLIGATIONS.MISSING_SECTION,
        detail: `PROTOCOL.md missing: ${pattern.id}`,
      });
    }
  }

  if (!existsSync(siteLandingPath)) {
    violations.push({
      obligation: OBLIGATIONS.MISSING_SITE_LANDING,
      detail: "docs-site/src/quickstarts/stranger-test.md is required",
    });
  } else {
    const landing = readFileSync(siteLandingPath, "utf8");
    if (!/PROTOCOL|stranger/i.test(landing)) {
      violations.push({
        obligation: OBLIGATIONS.MISSING_SITE_LANDING,
        detail: "site landing must point at stranger-test protocol",
      });
    }
  }

  const findingsFiles = listFindingsFiles(findingsDir);
  if (findingsFiles.length === 0) {
    violations.push({
      obligation: OBLIGATIONS.MISSING_FINDINGS,
      detail: "at least one FINDINGS-YYYY-MM-DD.md recording is required",
    });
    return { status: 1, violations, findingsFiles };
  }

  const latest = findingsFiles.at(-1);
  const findings = readFileSync(path.join(findingsDir, latest), "utf8");
  for (const pattern of FINDINGS_PATTERNS) {
    if (!pattern.re.test(findings)) {
      violations.push({
        obligation: OBLIGATIONS.MISSING_SECTION,
        detail: `${latest} missing: ${pattern.id}`,
      });
    }
  }

  if (!/F-00\d/.test(findings)) {
    violations.push({
      obligation: OBLIGATIONS.MISSING_FRICTION,
      detail: `${latest} must list friction IDs (F-00N)`,
    });
  }

  // Invariant: no bare "waived" / "waive? yes" without P7 deferral language.
  const waiveYes = findings.match(/\|\s*yes\s*\|/gi) ?? [];
  for (const _ of waiveYes) {
    if (!/P7|defer/i.test(findings)) {
      violations.push({
        obligation: OBLIGATIONS.WAIVED_WITHOUT_DEFER,
        detail: `${latest}: cannot waive blockers without P7 deferral`,
      });
      break;
    }
  }

  if (!/subjectId/i.test(findings) || !/never|no raw learner|utterance body/i.test(findings)) {
    violations.push({
      obligation: OBLIGATIONS.SOVEREIGNTY,
      detail: `${latest}: must record subjectId and no-raw-content posture`,
    });
  }

  return {
    status: violations.length === 0 ? 0 : 1,
    violations,
    findingsFiles,
    latestFindings: latest,
  };
}

export function runStrangerTestProtocolCheck(opts = {}) {
  const subjectId = opts.subjectId ?? "docs-site-stranger-check";
  const deviceId = opts.deviceId ?? "ci";
  const emitEvents = opts.emitEvents !== false;

  const result = validateStrangerTestProtocol(opts);
  if (result.status !== 0) {
    if (emitEvents) {
      emit({
        outcome: "fail",
        subjectId,
        deviceId,
        phase: "validate",
        violationCount: result.violations.length,
      });
    }
    return {
      status: 1,
      violations: result.violations,
      combined: result.violations
        .map((v) => `[${v.obligation}] ${v.detail}`)
        .join("\n"),
    };
  }

  if (emitEvents) {
    emit({
      outcome: "ok",
      subjectId,
      deviceId,
      phase: "validate",
      findings: result.latestFindings,
    });
  }

  return {
    status: 0,
    violations: [],
    findingsFiles: result.findingsFiles,
    combined: `OK: stranger-test protocol + findings (${result.latestFindings})`,
  };
}

function main() {
  const result = runStrangerTestProtocolCheck();
  if (result.status !== 0) {
    process.stderr.write(`${result.combined}\n`);
    process.exit(result.status);
  }
  process.stdout.write(`${result.combined}\n`);
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main();
}
