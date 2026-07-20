/**
 * Mix policy linter on corpus manifests (lane tags → effective weights).
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MIX_POLICY_LINT_FIXTURE_DIR,
  MIX_POLICY_LINT_OK_REPAIR,
  MIX_POLICY_LINT_VIOLATION_REPAIR,
  MIX_POLICY_LINT_VIOLATION_RET,
  MIX_REPAIR_TARGET_WEIGHT,
  MIX_RET_WEIGHT,
  computeEffectiveMixWeightsFromManifest,
  lintCorpusManifestMixPolicy,
  lintCorpusManifestMixPolicyFile,
  proveMixPolicyLint,
  runProveMixPolicyLintCli,
} from "../dist/mix_policy.js";
import { loadCorpusManifestFile, parseCorpusManifest } from "../dist/build.js";
import { readFileSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, "..");
const FIXTURES = path.join(PKG_ROOT, MIX_POLICY_LINT_FIXTURE_DIR);
const SECRET = "LEARNER_UTTERANCE_MUST_NOT_LEAK";

test("happy path: minimal + repair-curriculum manifests lint green", () => {
  const events = [];
  const minimal = lintCorpusManifestMixPolicyFile(
    path.join(PKG_ROOT, "fixtures", "valid", "minimal.json"),
    {
      subjectId: "subj.mix-lint.green",
      deviceId: "dev-mix-lint",
      onTelemetry: (e) => events.push(e),
    },
  );
  assert.equal(minimal.ok, true, JSON.stringify(minimal));
  if (!minimal.ok) return;
  assert.equal(minimal.effective.modeWeights.RET, MIX_RET_WEIGHT);

  const repair = lintCorpusManifestMixPolicyFile(
    path.join(FIXTURES, MIX_POLICY_LINT_OK_REPAIR),
    {
      subjectId: "subj.mix-lint.green",
      deviceId: "dev-mix-lint",
      onTelemetry: (e) => events.push(e),
    },
  );
  assert.equal(repair.ok, true, JSON.stringify(repair));
  if (!repair.ok) return;
  assert.equal(repair.effective.repairSourcesPresent, true);
  assert.ok(
    events.some((e) => e.op === "lint" && e.outcome === "ok" && e.subjectId),
  );
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test("happy path: effective weights exclude RET and surface lane codes", () => {
  const loaded = loadCorpusManifestFile(
    path.join(PKG_ROOT, "fixtures", "valid", "minimal.json"),
    { subjectId: "subj.mix-lint.eff", deviceId: "dev-mix-lint" },
  );
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  const effective = computeEffectiveMixWeightsFromManifest(loaded.value);
  assert.equal(effective.modeWeights.RET, MIX_RET_WEIGHT);
  assert.equal(effective.retSourceCount, 1);
  assert.ok(effective.laneCodes.includes("teacher"));
  assert.equal(effective.weightEligibleSourceCount, 1);
});

test("edge: RET policy / missing exclude_ret_from_weights fails ret_in_weights", () => {
  const raw = JSON.parse(
    readFileSync(path.join(FIXTURES, MIX_POLICY_LINT_VIOLATION_RET), "utf8"),
  );
  const parsed = parseCorpusManifest(raw, {
    subjectId: "subj.mix-lint.ret",
    deviceId: "dev-mix-lint",
  });
  // Schema may reject before lint; both count as the RET-in-weights class.
  if (!parsed.ok) {
    assert.ok(
      parsed.failureClass === "ret_policy" ||
        parsed.message.toLowerCase().includes("ret"),
      parsed.message,
    );
    return;
  }
  const events = [];
  const linted = lintCorpusManifestMixPolicy(parsed.value, {
    subjectId: "subj.mix-lint.ret",
    deviceId: "dev-mix-lint",
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(linted.ok, false);
  if (linted.ok) return;
  assert.equal(linted.failureClass, "ret_in_weights");
  assert.ok(events.some((e) => e.failureClass === "ret_in_weights"));
});

test("edge: repair stage weight out of band fails repair_out_of_band", () => {
  const events = [];
  const linted = lintCorpusManifestMixPolicyFile(
    path.join(FIXTURES, MIX_POLICY_LINT_VIOLATION_REPAIR),
    {
      subjectId: "subj.mix-lint.repair",
      deviceId: "dev-mix-lint",
      onTelemetry: (e) => events.push(e),
    },
  );
  assert.equal(linted.ok, false, JSON.stringify(linted));
  if (linted.ok) return;
  assert.equal(linted.failureClass, "repair_out_of_band");
  assert.ok(
    events.some(
      (e) => e.op === "lint" && e.failureClass === "repair_out_of_band",
    ),
  );
});

test("sovereignty: subjectId scoped telemetry; replay is idempotent", () => {
  const file = path.join(FIXTURES, MIX_POLICY_LINT_OK_REPAIR);
  const a = lintCorpusManifestMixPolicyFile(file, {
    subjectId: "subj.mix-lint.a",
    deviceId: "dev-a",
  });
  const b = lintCorpusManifestMixPolicyFile(file, {
    subjectId: "subj.mix-lint.a",
    deviceId: "dev-a",
  });
  assert.deepEqual(a, b);
  assert.equal(a.ok, true);
  if (!a.ok) return;
  assert.equal(a.subjectId, "subj.mix-lint.a");

  const other = lintCorpusManifestMixPolicyFile(file, {
    subjectId: "subj.mix-lint.b",
    deviceId: "dev-b",
  });
  assert.equal(other.ok, true);
  if (!other.ok) return;
  assert.equal(other.subjectId, "subj.mix-lint.b");
  assert.equal(other.manifestId, a.manifestId);
  assert.notEqual(other.subjectId, a.subjectId);
});

test("prove: CI gate green fixtures + seeded reds; CLI exit 0", () => {
  const events = [];
  const first = proveMixPolicyLint({
    packageRoot: PKG_ROOT,
    subjectId: "subj.mix-lint.prove",
    deviceId: "dev-mix-prove",
    onTelemetry: (e) => events.push(e),
  });
  const second = proveMixPolicyLint({
    packageRoot: PKG_ROOT,
    subjectId: "subj.mix-lint.prove",
    deviceId: "dev-mix-prove",
  });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.deepEqual(first, second);
  if (!first.ok) return;
  assert.equal(first.greenCount, 2);
  assert.equal(first.redCount, 2);
  assert.ok(
    events.some((e) => e.op === "prove_lint" && e.outcome === "ok"),
  );

  const chunks = [];
  const code = runProveMixPolicyLintCli([], {
    stdout: { write: (s) => chunks.push(s) },
    stderr: { write: (s) => chunks.push(s) },
  });
  assert.equal(code, 0);
  assert.ok(chunks.join("").includes('"outcome":"ok"'));
  assert.equal(MIX_REPAIR_TARGET_WEIGHT, 0.5);
});
