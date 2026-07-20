/**
 * CI gate wiring for flagship knowledge packs (validate + freshness).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FLAGSHIP_PACK_IDS,
  assertFlagshipPackTreesPresent,
  proveFlagshipPacksCiGate,
  runFlagshipPacksCiGate,
  runFlagshipPacksCiGateCli,
} from "../dist/index.js";

import {
  extractJobBlock,
  loadNightlyCi,
} from "../../../scripts/ci-workflow-test-helpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(PKG_ROOT, "../..");
const PKG_JSON = path.join(PKG_ROOT, "package.json");
const SECRET = "LEARNER_OR_PATIENT_CONTENT_MUST_NOT_LEAK";

function loadCi() {
  return loadNightlyCi();
}

test("unit: knowledge-flagship-packs job wires validate + freshness + prove", () => {
  const yml = loadCi();
  const block = extractJobBlock(yml, "certifications");
  assert.doesNotMatch(block, /needs:\s*\[typescript\]/);
  assert.match(block, /pnpm install --frozen-lockfile/);
  assert.match(block, /pnpm build/);
  assert.match(block, /sutra-bindings-knowledge run ci:flagship-packs/);
  assert.match(block, /ci:prove:flagship-packs/);
  assert.match(block, /knowledge-packs/);
  assert.match(block, /validate-pack|flagship/i);
  assert.match(block, /upload-artifact@v4/);
  assert.match(block, /if:\s*always\(\)/);
  assert.match(block, /pnpm\/action-setup@v4/);
  assert.match(block, /version:\s*10\.30\.3/);
  assert.match(block, /node-version:\s*22/);
  assert.doesNotMatch(block, /strategy:\s*\n\s*matrix:/);

  const pkg = JSON.parse(readFileSync(PKG_JSON, "utf8"));
  assert.equal(typeof pkg.scripts["ci:flagship-packs"], "string");
  assert.equal(typeof pkg.scripts["ci:prove:flagship-packs"], "string");
  assert.match(pkg.scripts["ci:flagship-packs"], /ci_flagship_packs/);
  assert.match(pkg.scripts["ci:prove:flagship-packs"], /--prove/);
});

test("happy path: flagship packs CI gate is green on committed trees", () => {
  assertFlagshipPackTreesPresent();
  const events = [];
  const result = runFlagshipPacksCiGate({
    subjectId: "subj.flag.ci.ok",
    deviceId: "dev-flag-ci",
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(result.ok, true, JSON.stringify(result.failures));
  assert.equal(result.rows.length, FLAGSHIP_PACK_IDS.length);
  assert.ok(result.rows.every((r) => r.validateOk && r.freshnessOk));
  assert.ok(events.some((e) => e.event === "bindings_knowledge.flagship_packs_ci"));
  assert.ok(!JSON.stringify(events).includes(SECRET));
  assert.ok(!JSON.stringify(events).includes("Paracetamol"));
  assert.ok(!JSON.stringify(events).includes("3:4 and 6:8"));
});

test("happy path: CLI gate exits 0", () => {
  const out = [];
  const err = [];
  const code = runFlagshipPacksCiGateCli([], {
    stdout: { write(s) { out.push(s); } },
    stderr: { write(s) { err.push(s); } },
  });
  assert.equal(code, 0, err.join(""));
  assert.match(out.join(""), /"outcome":"ok"/);
});

test("edge: prove red→green covers stale fingerprint and uncited validate", () => {
  const events = [];
  const proof = proveFlagshipPacksCiGate({
    subjectId: "subj.flag.ci.prove",
    deviceId: "dev-flag-ci",
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(proof.ok, true, JSON.stringify(proof.failures));
  assert.equal(proof.greenOk, true);
  assert.equal(proof.staleRedOk, true);
  assert.equal(proof.uncitedRedOk, true);
  assert.ok(events.some((e) => e.op === "prove" && e.outcome === "red"));
  assert.ok(events.some((e) => e.op === "prove" && e.outcome === "green"));
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test("sovereignty: CI gate is subject-scoped and never imports domains/", () => {
  const events = [];
  runFlagshipPacksCiGate({
    subjectId: "subj.flag.ci.iso-a",
    deviceId: "dev-a",
    onTelemetry: (e) => events.push(e),
  });
  runFlagshipPacksCiGate({
    subjectId: "subj.flag.ci.iso-b",
    deviceId: "dev-b",
    onTelemetry: (e) => events.push(e),
  });
  assert.ok(events.some((e) => e.subjectId === "subj.flag.ci.iso-a"));
  assert.ok(events.some((e) => e.subjectId === "subj.flag.ci.iso-b"));

  const gateSrc = readFileSync(
    path.join(PKG_ROOT, "src", "pack_ci_gate.ts"),
    "utf8",
  );
  assert.ok(!/from\s+["'].*domains\//.test(gateSrc));
  assert.ok(!/import\s+["'].*domains\//.test(gateSrc));
});
