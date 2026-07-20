/**
 * CI wiring for the benchmarks gate job.
 * Run: pnpm --filter @moolam/benchmarks test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractJobBlock,
  loadNightlyCi,
} from "../../scripts/ci-workflow-test-helpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_JSON = path.join(__dirname, "../package.json");

function log(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "benchmarks.ci_job.test", ...event })}\n`,
  );
}

test("happy path: nightly benchmarks job runs ci:gate after build", () => {
  const yml = loadNightlyCi();
  assert.match(yml, /^  benchmarks-guidance:/m);
  const block = extractJobBlock(yml, "benchmarks-guidance");
  assert.doesNotMatch(block, /needs:\s*\[typescript\]/);
  assert.match(block, /pnpm install --frozen-lockfile/);
  assert.match(block, /pnpm build/);
  assert.match(block, /setup-python@v5/);
  assert.match(block, /pip install -e \./);
  assert.match(block, /@moolam\/benchmarks run ci:gate/);
  assert.match(block, /--baseline|ci:gate/);
  assert.match(block, /tee artifacts\/benchmarks\/gate\.log/);
  assert.match(block, /upload-artifact@v4/);
  assert.match(block, /Benchmarks & guidance/);

  const pkg = JSON.parse(readFileSync(PKG_JSON, "utf8"));
  assert.equal(
    typeof pkg.scripts["ci:gate"],
    "string",
    "ci:gate script required for pinned CI entrypoint",
  );
  assert.match(pkg.scripts["ci:gate"], /--baseline gates\/baseline\.json/);
  log({ outcome: "ok", case: "ci-job-wired", subjectId: null });
});

test("edge: pnpm/node versions pinned; benches stay single-threaded", () => {
  const block = extractJobBlock(loadNightlyCi(), "benchmarks-guidance");
  assert.match(block, /pnpm\/action-setup@v4/);
  assert.match(block, /version:\s*10\.30\.3/);
  assert.match(block, /node-version:\s*22/);
  assert.match(block, /pnpm install --frozen-lockfile/);
  assert.doesNotMatch(block, /strategy:\s*\n\s*matrix:/);
  assert.match(block, /Single-threaded|single-threaded/i);
  log({ outcome: "ok", case: "pinned-single-threaded", subjectId: null });
});

test("edge: gate failure must keep DIFF/table in job log (tee + always artifact)", () => {
  const block = extractJobBlock(loadNightlyCi(), "benchmarks-guidance");
  assert.match(block, /tee /);
  assert.match(block, /if:\s*always\(\)/);
  assert.match(block, /artifacts\/benchmarks\//);
  const buildAt = block.indexOf("pnpm build");
  const gateAt = block.indexOf("ci:gate");
  assert.ok(buildAt >= 0 && gateAt > buildAt, "build must run before ci:gate");
  log({ outcome: "ok", case: "diff-in-log", subjectId: null });
});
