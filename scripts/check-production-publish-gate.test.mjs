/**
 * Unit coverage for the P5 production-publish gate (freeze RFC unlock).
 * Run: node --test scripts/check-production-publish-gate.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OBLIGATIONS,
  buildGateDocument,
  checkProductionPublishGate,
  parseFreezeAcceptance,
} from "./check-production-publish-gate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CI = path.join(REPO_ROOT, ".github", "workflows", "ci.yml");
const RELEASE = path.join(REPO_ROOT, ".github", "workflows", "release.yml");
const ROOT_PKG = path.join(REPO_ROOT, "package.json");
const RFC = path.join(REPO_ROOT, "rfcs", "0001-protocol-1.0-freeze.md");
const GATE = path.join(
  REPO_ROOT,
  "rfcs",
  "appendix",
  "production-publish-gate.json",
);

function minimalRfc(overrides = {}) {
  const status =
    overrides.status ??
    "Draft — acceptance blocked by FP-002 and pending maintainer sign-off";
  const signoff = overrides.signoff ?? "**Pending** — names and dates required";
  const fp002Status = overrides.fp002Status ?? "**Blocks acceptance**";
  return `# RFC 0001: Protocol 1.0 freeze

| Field | Value |
|-------|-------|
| **Status** | ${status} |
| **Maintainer acceptance** | ${signoff} |

## Maintainer acceptance workflow

Run \`pnpm production-publish:gate\` then set \`NPM_ALLOW_PROD_PUBLISH\`.

## Open issue disposition

No issue may be omitted. Each row is closed, waived with expiry, or blocks acceptance.

| Issue | Severity | Status | Owner | Expiry / review date | Evidence / required action |
|-------|----------|--------|-------|----------------------|----------------------------|
| \`FP-002\` | P1 | ${fp002Status} | Speech | — | fixture |
| \`GHSA-x\` | High | Waived for tooling | Track A | 2026-10-01 | audit |
| \`F-EXT-008\` | P3 | Accepted residual | Ops | 2026-10-01 | residual |

## Acceptance criteria

subjectId and deviceId scoped; never raw learner content; outcome recorded.
`;
}

function writeFixtureTree(dir, rfcBody, gateDoc, releaseText, checklistText) {
  const rfcPath = path.join(dir, "rfc.md");
  const gatePath = path.join(dir, "gate.json");
  const releasePath = path.join(dir, "release.yml");
  const checklistPath = path.join(dir, "checklist.md");
  writeFileSync(rfcPath, rfcBody, "utf8");
  writeFileSync(gatePath, `${JSON.stringify(gateDoc, null, 2)}\n`, "utf8");
  writeFileSync(releasePath, releaseText, "utf8");
  writeFileSync(checklistPath, checklistText, "utf8");
  return { rfcPath, gatePath, releasePath, checklistPath };
}

const WIRED_RELEASE = `
name: Release
steps:
  - run: node scripts/check-production-publish-gate.mjs
  - run: echo FREEZE_RFC_UNLOCKED
    # production-publish-gate.json
  - run: echo ALLOW_PROD
`;

const WIRED_CHECKLIST = `
# Checklist
pnpm production-publish:gate
FREEZE_RFC_UNLOCKED
rfcs/0001-protocol-1.0-freeze.md
NPM_ALLOW_PROD_PUBLISH
`;

test("happy path: committed Accepted RFC unlocks production publish and gate green", () => {
  const result = checkProductionPublishGate();
  assert.equal(result.ok, true, result.failures.join("\n"));
  assert.equal(result.unlocked, true);
  const gate = JSON.parse(readFileSync(GATE, "utf8"));
  assert.equal(gate.unlocked, true);
  assert.equal(gate.npmAllowProdPublish, "true");
  assert.match(readFileSync(RFC, "utf8"), /## Maintainer acceptance workflow/);
});

test("edge: Accepted without named dated sign-off stays locked and fails", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-prod-signoff-"));
  try {
    const rfc = minimalRfc({
      status: "Accepted",
      signoff: "**Pending** — incomplete",
      fp002Status: "Closed",
    });
    const parsed = parseFreezeAcceptance(rfc);
    assert.equal(parsed.unlocked, false);
    const gate = buildGateDocument({
      unlocked: false,
      status: parsed.status,
      signoff: parsed.signoff,
      reason: parsed.reason,
      evaluatedAt: "2026-07-17T00:00:00.000Z",
    });
    const paths = writeFixtureTree(
      dir,
      rfc,
      gate,
      WIRED_RELEASE,
      WIRED_CHECKLIST,
    );
    const result = checkProductionPublishGate({
      ...paths,
      allowProdEnv: "false",
    });
    assert.equal(result.ok, false);
    assert.ok(result.failures.includes(OBLIGATIONS.ACCEPTED_WITHOUT_SIGNOFF));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edge: Accepted with blocking issue fails; unlocked JSON while Draft fails", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-prod-block-"));
  try {
    const rfc = minimalRfc({
      status: "Accepted",
      signoff: "Alice <a@example.com> 2026-07-17",
      fp002Status: "**Blocks acceptance**",
    });
    const parsed = parseFreezeAcceptance(rfc);
    assert.equal(parsed.unlocked, false);
    const gate = buildGateDocument({
      unlocked: true,
      status: parsed.status,
      signoff: parsed.signoff,
      reason: "tampered unlock",
      evaluatedAt: "2026-07-17T00:00:00.000Z",
    });
    const paths = writeFixtureTree(
      dir,
      rfc,
      gate,
      WIRED_RELEASE,
      WIRED_CHECKLIST,
    );
    const result = checkProductionPublishGate({
      ...paths,
      allowProdEnv: "false",
    });
    assert.equal(result.ok, false);
    assert.ok(result.failures.includes(OBLIGATIONS.ACCEPTED_WITH_BLOCKER));
    assert.ok(
      result.failures.some(
        (f) =>
          f === OBLIGATIONS.UNLOCKED_WHILE_DRAFT ||
          f.startsWith(OBLIGATIONS.GATE_FILE_DRIFT),
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edge: replay write is idempotent for unlock decision", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-prod-replay-"));
  try {
    const rfc = minimalRfc({
      status: "Accepted",
      signoff: "Alice <a@example.com> 2026-07-17; Bob <b@example.com> 2026-07-17",
      fp002Status: "Closed — fixture landed",
    });
    writeFileSync(path.join(dir, "rfc.md"), rfc, "utf8");
    writeFileSync(path.join(dir, "release.yml"), WIRED_RELEASE, "utf8");
    writeFileSync(path.join(dir, "checklist.md"), WIRED_CHECKLIST, "utf8");
    const gatePath = path.join(dir, "gate.json");
    const first = checkProductionPublishGate({
      rfcPath: path.join(dir, "rfc.md"),
      gatePath,
      releasePath: path.join(dir, "release.yml"),
      checklistPath: path.join(dir, "checklist.md"),
      write: true,
      allowProdEnv: "false",
    });
    assert.equal(first.ok, true, first.failures.join("\n"));
    assert.equal(first.unlocked, true);
    const snap = JSON.parse(readFileSync(gatePath, "utf8"));
    const { evaluatedAt: _a, ...stable1 } = snap;
    const second = checkProductionPublishGate({
      rfcPath: path.join(dir, "rfc.md"),
      gatePath,
      releasePath: path.join(dir, "release.yml"),
      checklistPath: path.join(dir, "checklist.md"),
      write: true,
      allowProdEnv: "false",
    });
    assert.equal(second.ok, true, second.failures.join("\n"));
    const snap2 = JSON.parse(readFileSync(gatePath, "utf8"));
    const { evaluatedAt: _b, ...stable2 } = snap2;
    assert.deepEqual(stable2, stable1);
    assert.equal(stable2.unlocked, true);
    assert.equal(stable2.npmAllowProdPublish, "true");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sovereignty: concurrent subject scopes stay isolated in gate events", () => {
  const a = parseFreezeAcceptance(
    minimalRfc({
      status: "Accepted",
      signoff: "A <a@example.com> 2026-07-17",
      fp002Status: "Closed",
    }),
  );
  const b = parseFreezeAcceptance(
    minimalRfc({
      status: "Draft",
      signoff: "**Pending**",
      fp002Status: "**Blocks acceptance**",
    }),
  );
  assert.equal(a.unlocked, true);
  assert.equal(b.unlocked, false);
  const docA = buildGateDocument({
    unlocked: a.unlocked,
    status: a.status,
    signoff: a.signoff,
    reason: a.reason,
    subjectId: "subj-a",
    deviceId: "dev-a",
    evaluatedAt: "t",
  });
  const docB = buildGateDocument({
    unlocked: b.unlocked,
    status: b.status,
    signoff: b.signoff,
    reason: b.reason,
    subjectId: "subj-b",
    deviceId: "dev-b",
    evaluatedAt: "t",
  });
  assert.notEqual(docA.subjectId, docB.subjectId);
  assert.notEqual(docA.unlocked, docB.unlocked);
});

test("release.yml, CI, and package scripts wire FREEZE_RFC_UNLOCKED", () => {
  const release = readFileSync(RELEASE, "utf8");
  assert.match(release, /check-production-publish-gate\.mjs/);
  assert.match(release, /FREEZE_RFC_UNLOCKED/);
  assert.match(release, /production-publish-gate\.json/);
  assert.match(
    release,
    /Production publish requested but FREEZE_RFC_UNLOCKED/,
  );

  const ci = readFileSync(CI, "utf8");
  assert.match(ci, /pnpm production-publish:gate/);
  assert.match(ci, /check-production-publish-gate\.test\.mjs/);

  const pkg = JSON.parse(readFileSync(ROOT_PKG, "utf8"));
  assert.equal(
    pkg.scripts["production-publish:gate"],
    "node scripts/check-production-publish-gate.mjs",
  );
});
