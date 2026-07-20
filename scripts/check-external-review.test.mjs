/**
 * Unit coverage for the external security review scope gate.
 * Run: node --test scripts/check-external-review.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXTERNAL_REVIEW,
  OBLIGATIONS,
  REQUIRED_SURFACES,
  checkExternalReview,
  codeAnchors,
  parseFindings,
  surfaceBlock,
} from "./check-external-review.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CI_WORKFLOW = path.join(REPO_ROOT, ".github", "workflows", "ci.yml");

/** Minimal document that satisfies every obligation against a scratch repo. */
function validDoc(anchor) {
  const surfaces = REQUIRED_SURFACES.map(
    (id, i) =>
      [
        `### Surface R${i + 1} — name (\`${id}\`)`,
        "",
        `| Code under review | \`${anchor}\` |`,
      ].join("\n"),
  ).join("\n\n");
  return [
    "# review",
    "## Engagement record",
    "table",
    "## Review scope",
    surfaces,
    "## Independence rules",
    "1. must not have authored",
    "2. fresh clone",
    "3. before reading the mitigation",
    "4. never triaged or downgraded by the code's author",
    "5. named reviewer and date",
    "## Methodology",
    "protocol parsing, auth bypass, sandbox escape — not just dependency CVEs.",
    "synthetic subjects only; evidence carries subjectId metadata, never raw utterances.",
    "## Severity policy",
    "P0 and P1 findings block freeze RFC acceptance.",
    "## Findings register",
    "| Finding ID | Surface | Severity | Status | Owner | Re-test evidence |",
    "|---|---|---|---|---|---|",
    `| \`F-EXT-001\` | auth | P1 | closed | Track A lead | \`${anchor}\` |`,
    `| \`F-EXT-002\` | sandbox | P3 | accepted | Domain integrator | see RR-HOST-TOOL-001 |`,
    "## Closure checklist",
    "- [x] No P0 or P1 finding remains open.",
    "## Correlation",
    "table",
  ].join("\n");
}

/** Scratch repo with one real anchor file, returns { dir, reviewPath, anchor }. */
function scratchRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-extrev-"));
  const anchor = "packages/demo/src/thing.ts";
  mkdirSync(path.join(dir, "packages", "demo", "src"), { recursive: true });
  writeFileSync(path.join(dir, anchor), "export const x = 1;", "utf8");
  const reviewPath = path.join(dir, "EXTERNAL-REVIEW.md");
  return { dir, reviewPath, anchor };
}

test("happy path: committed EXTERNAL-REVIEW.md passes with resolving anchors", () => {
  const result = checkExternalReview();
  assert.equal(result.ok, true, result.failures.join("\n"));
  assert.equal(result.surfaces, REQUIRED_SURFACES.length);
  assert.ok(result.anchors >= REQUIRED_SURFACES.length);
});

test("helpers: surfaceBlock and codeAnchors extract per-surface anchors", () => {
  const body = readFileSync(EXTERNAL_REVIEW, "utf8");
  const block = surfaceBlock(body, "auth");
  assert.ok(block.includes("auth.py"));
  assert.ok(
    codeAnchors(block).includes(
      "packages/cloud-orchestrator/src/sutra_orchestrator/auth.py",
    ),
  );
});

test("edge: missing document fails MISSING_DOC", () => {
  const result = checkExternalReview({
    reviewPath: path.join(tmpdir(), "no-such-external-review.md"),
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.startsWith(OBLIGATIONS.MISSING_DOC)));
});

test("edge: dropped surface fails MISSING_SURFACE naming it", () => {
  const { dir, reviewPath, anchor } = scratchRepo();
  try {
    const body = validDoc(anchor).replace("(`sandbox`)", "(`renamed`)");
    writeFileSync(reviewPath, body, "utf8");
    const result = checkExternalReview({ reviewPath, repoRoot: dir });
    assert.equal(result.ok, false);
    assert.ok(
      result.failures.includes(`${OBLIGATIONS.MISSING_SURFACE}:sandbox`),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edge: anchor that does not resolve on disk fails BROKEN_CODE_ANCHOR", () => {
  const { dir, reviewPath, anchor } = scratchRepo();
  try {
    const body = validDoc(anchor).replace(
      new RegExp(`\\(\`protocol\`\\)([\\s\\S]*?)\`${anchor}\``),
      "(`protocol`)$1`packages/demo/src/deleted.ts`",
    );
    writeFileSync(reviewPath, body, "utf8");
    const result = checkExternalReview({ reviewPath, repoRoot: dir });
    assert.equal(result.ok, false);
    assert.ok(
      result.failures.includes(
        `${OBLIGATIONS.BROKEN_CODE_ANCHOR}:protocol:packages/demo/src/deleted.ts`,
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edge: dropped independence rule fails naming the rule", () => {
  const { dir, reviewPath, anchor } = scratchRepo();
  try {
    const body = validDoc(anchor).replace(
      "4. never triaged or downgraded by the code's author\n",
      "",
    );
    writeFileSync(reviewPath, body, "utf8");
    const result = checkExternalReview({ reviewPath, repoRoot: dir });
    assert.equal(result.ok, false);
    assert.ok(
      result.failures.includes(
        `${OBLIGATIONS.MISSING_INDEPENDENCE_RULE}:independent_reporting`,
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edge: severity policy without freeze-RFC block fails", () => {
  const { dir, reviewPath, anchor } = scratchRepo();
  try {
    const body = validDoc(anchor).replace(
      "P0 and P1 findings block freeze RFC acceptance.",
      "P0 and P1 findings are important.",
    );
    writeFileSync(reviewPath, body, "utf8");
    const result = checkExternalReview({ reviewPath, repoRoot: dir });
    assert.equal(result.ok, false);
    assert.ok(result.failures.includes(OBLIGATIONS.MISSING_SEVERITY_POLICY));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edge: scope reduced to CVE scanning fails CVE_ONLY_SCOPE", () => {
  const { dir, reviewPath, anchor } = scratchRepo();
  try {
    const body = validDoc(anchor).replace(
      "protocol parsing, auth bypass, sandbox escape — not just dependency CVEs.",
      "we scan dependency CVEs.",
    );
    writeFileSync(reviewPath, body, "utf8");
    const result = checkExternalReview({ reviewPath, repoRoot: dir });
    assert.equal(result.ok, false);
    assert.ok(result.failures.includes(OBLIGATIONS.CVE_ONLY_SCOPE));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sovereignty: dropping the synthetic-subjects constraint fails", () => {
  const { dir, reviewPath, anchor } = scratchRepo();
  try {
    const body = validDoc(anchor).replace(
      "synthetic subjects only; evidence carries subjectId metadata, never raw utterances.",
      "reviewers may use any data.",
    );
    writeFileSync(reviewPath, body, "utf8");
    const result = checkExternalReview({ reviewPath, repoRoot: dir });
    assert.equal(result.ok, false);
    assert.ok(result.failures.includes(OBLIGATIONS.SOVEREIGNTY));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edge: missing findings register columns fails MISSING_REGISTER", () => {
  const { dir, reviewPath, anchor } = scratchRepo();
  try {
    const body = validDoc(anchor).replace(
      "| Finding ID | Surface | Severity | Status | Owner | Re-test evidence |",
      "| stuff |",
    );
    writeFileSync(reviewPath, body, "utf8");
    const result = checkExternalReview({ reviewPath, repoRoot: dir });
    assert.equal(result.ok, false);
    assert.ok(result.failures.includes(OBLIGATIONS.MISSING_REGISTER));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("triage: committed register has no open P0/P1 and evidence resolves", () => {
  const result = checkExternalReview();
  assert.equal(result.ok, true, result.failures.join("\n"));
  assert.ok(result.findings >= 7, "review must file the triaged findings");
});

test("helpers: parseFindings reads id, severity, status, evidence", () => {
  const body = readFileSync(EXTERNAL_REVIEW, "utf8");
  const findings = parseFindings(body);
  const f3 = findings.find((f) => f.id === "F-EXT-003");
  assert.equal(f3?.severity, "P0");
  assert.equal(f3?.status, "closed");
  assert.ok(f3?.evidence.endsWith("tool_policy_risk_class.test.mjs"));
  // Every P0/P1 finding is closed.
  for (const f of findings) {
    if (f.severity === "P0" || f.severity === "P1") {
      assert.equal(f.status, "closed", `${f.id} must be closed`);
    }
  }
});

test("triage edge: an open P1 finding fails OPEN_P0P1_FINDING", () => {
  const { dir, reviewPath, anchor } = scratchRepo();
  try {
    const body = validDoc(anchor).replace(
      "| `F-EXT-001` | auth | P1 | closed | Track A lead |",
      "| `F-EXT-001` | auth | P1 | open | Track A lead |",
    );
    writeFileSync(reviewPath, body, "utf8");
    const result = checkExternalReview({ reviewPath, repoRoot: dir });
    assert.equal(result.ok, false);
    assert.ok(
      result.failures.some((f) =>
        f.startsWith(`${OBLIGATIONS.OPEN_P0P1_FINDING}:F-EXT-001`),
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("triage edge: closed finding whose evidence file is gone fails BROKEN_EVIDENCE_LINK", () => {
  const { dir, reviewPath } = scratchRepo();
  try {
    const body = validDoc("packages/demo/src/deleted.ts");
    writeFileSync(reviewPath, body, "utf8");
    const result = checkExternalReview({ reviewPath, repoRoot: dir });
    assert.equal(result.ok, false);
    assert.ok(
      result.failures.some((f) =>
        f.startsWith(`${OBLIGATIONS.BROKEN_EVIDENCE_LINK}:F-EXT-001`),
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("triage edge: closed finding with no evidence path fails FINDING_WITHOUT_EVIDENCE", () => {
  const { dir, reviewPath, anchor } = scratchRepo();
  try {
    const body = validDoc(anchor).replace(
      `| \`F-EXT-001\` | auth | P1 | closed | Track A lead | \`${anchor}\` |`,
      "| `F-EXT-001` | auth | P1 | closed | Track A lead | pending |",
    );
    writeFileSync(reviewPath, body, "utf8");
    const result = checkExternalReview({ reviewPath, repoRoot: dir });
    assert.equal(result.ok, false);
    assert.ok(
      result.failures.includes(
        `${OBLIGATIONS.FINDING_WITHOUT_EVIDENCE}:F-EXT-001`,
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("triage edge: removing the closure checklist fails MISSING_CLOSURE_CHECKLIST", () => {
  const { dir, reviewPath, anchor } = scratchRepo();
  try {
    const body = validDoc(anchor).replace("## Closure checklist", "## Notes");
    writeFileSync(reviewPath, body, "utf8");
    const result = checkExternalReview({ reviewPath, repoRoot: dir });
    assert.equal(result.ok, false);
    assert.ok(result.failures.includes(OBLIGATIONS.MISSING_CLOSURE_CHECKLIST));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ci wires the external-review gate into the threat-model job", () => {
  const ci = readFileSync(CI_WORKFLOW, "utf8");
  assert.match(ci, /check-external-review\.mjs/);
  assert.match(ci, /check-external-review\.test\.mjs/);
  const pkg = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
  );
  assert.equal(
    pkg.scripts["external-review:check"],
    "node scripts/check-external-review.mjs",
  );
});
