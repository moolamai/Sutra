/**
 * Governance consistency: golden-replay operator doc ↔ real scripts / links.
 * Run: pnpm --filter @moolam/runtime-harness test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = join(__dirname, "..");
const REPO = join(PKG, "..", "..");
const GUIDE = join(PKG, "docs", "golden-replay-operator.md");
const PKG_README = join(PKG, "README.md");
const FIXTURES_README = join(PKG, "fixtures", "golden-turns", "README.md");
const PUBLIC_RUNTIME = join(REPO, "docs", "runtime", "README.md");
const PKG_JSON = join(PKG, "package.json");
const SYNC_SCRIPT = join(PKG, "scripts", "sync-a-p6-golden-turns.mjs");

function log(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

test("happy path: operator guide exists and is linked from package + public docs", () => {
  assert.ok(existsSync(GUIDE), "missing docs/golden-replay-operator.md");
  const guide = readFileSync(GUIDE, "utf8");
  assert.match(guide, /Operator workflow|golden:sync/i);

  const pkgReadme = readFileSync(PKG_README, "utf8");
  assert.match(pkgReadme, /docs\/golden-replay-operator\.md/);

  const fixturesReadme = readFileSync(FIXTURES_README, "utf8");
  assert.match(fixturesReadme, /golden-replay-operator\.md/);

  const publicRuntime = readFileSync(PUBLIC_RUNTIME, "utf8");
  assert.match(publicRuntime, /golden-replay-operator\.md/);

  log({
    event: "runtime.harness.golden_replay_operator_doc",
    outcome: "ok",
    subjectId: "anika-k",
    deviceId: "docs-gate",
    case: "links",
  });
});

test("happy path: guide commands match package.json scripts", () => {
  const guide = readFileSync(GUIDE, "utf8");
  const pkg = JSON.parse(readFileSync(PKG_JSON, "utf8"));
  for (const script of [
    "golden:sync",
    "golden:check",
    "golden:replay",
    "golden:fuzz",
    "golden:malformed",
  ]) {
    assert.ok(pkg.scripts[script], `package.json missing script ${script}`);
    assert.match(
      guide,
      new RegExp(script.replace(":", "\\:")),
      `guide must document ${script}`,
    );
  }
  log({
    event: "runtime.harness.golden_replay_operator_doc",
    outcome: "ok",
    subjectId: "anika-k",
    deviceId: "docs-gate",
    case: "scripts",
  });
});

test("edge: sync script never auto-commits (guide + script agree)", () => {
  const guide = readFileSync(GUIDE, "utf8");
  const syncBody = readFileSync(SYNC_SCRIPT, "utf8");
  assert.match(guide, /never auto-commits/i);
  assert.match(syncBody, /never auto-commits/i);
  assert.doesNotMatch(syncBody, /\bgit\s+commit\b/);
  assert.doesNotMatch(guide, /git\s+commit\s+--amend|auto-commit the sync/i);
  log({
    event: "runtime.harness.golden_replay_operator_doc",
    outcome: "ok",
    subjectId: "anika-k",
    deviceId: "docs-gate",
    case: "no_auto_commit",
  });
});

test("edge: guide covers new A P6 golden without B4 update + chunk purity", () => {
  const guide = readFileSync(GUIDE, "utf8");
  assert.match(guide, /New A P6 golden|MISSING_LOCAL/i);
  assert.match(guide, /multi-chunk|Chunk purity|chunk-boundary/i);
  assert.match(guide, /Do not hand-edit|No hand-edited/i);
  assert.match(guide, /malformed-fence/);
  assert.match(guide, /GOLDEN_TURN_DRIFT|unified diff/i);
  log({
    event: "runtime.harness.golden_replay_operator_doc",
    outcome: "ok",
    subjectId: "anika-k",
    deviceId: "docs-gate",
    case: "edge_coverage",
  });
});

test("sovereignty: guide forbids pasting learner content into tickets/logs", () => {
  const guide = readFileSync(GUIDE, "utf8");
  assert.match(guide, /learner|utterance|PII/i);
  assert.match(guide, /subjectId/);
  assert.ok(!guide.includes("consider ratio"));
  log({
    event: "runtime.harness.golden_replay_operator_doc",
    outcome: "ok",
    subjectId: "anika-k",
    deviceId: "docs-gate",
    case: "sovereignty",
  });
});

test("scalability: guide names bounded CI / soft-cap failure classes", () => {
  const guide = readFileSync(GUIDE, "utf8");
  assert.match(guide, /parser-chunk-fuzz|CHUNK_BOUNDARY_FUZZ_DRIFT/);
  assert.match(guide, /EXTRA_LOCAL|top-level/);
  log({
    event: "runtime.harness.golden_replay_operator_doc",
    outcome: "ok",
    subjectId: "anika-k",
    deviceId: "docs-gate",
    case: "observability_table",
  });
});
