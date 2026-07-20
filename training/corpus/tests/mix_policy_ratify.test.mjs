/**
 * Mix policy ratification: version hash, stakeholder sign-off, promotion gate.
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MIX_POLICY_LINT_FIXTURE_DIR,
  MIX_POLICY_LINT_OK_REPAIR,
  MIX_POLICY_LINT_VIOLATION_VERSION,
  MIX_POLICY_MIN_STAKEHOLDERS,
  MIX_POLICY_REQUIRED_STAKEHOLDER_ROLES,
  MIX_POLICY_SIGNOFF_RELPATH,
  assertMixPolicyPromotion,
  assertMixPolicyPromotionFile,
  assertMixPolicySignoff,
  computeMixPolicyVersion,
  loadMixPolicySignoff,
  proveMixPolicyRatification,
} from "../dist/mix_policy.js";
import { loadCorpusManifestFile } from "../dist/build.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, "..");
const FIXTURES = path.join(PKG_ROOT, MIX_POLICY_LINT_FIXTURE_DIR);
const SECRET = "LEARNER_UTTERANCE_MUST_NOT_LEAK";

test("happy path: compute version + ratified sign-off match", () => {
  const events = [];
  const versioned = computeMixPolicyVersion({
    packageRoot: PKG_ROOT,
    subjectId: "subj.mix-ratify.ok",
    deviceId: "dev-mix-ratify",
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(versioned.ok, true, JSON.stringify(versioned));
  if (!versioned.ok) return;

  const signed = assertMixPolicySignoff({
    packageRoot: PKG_ROOT,
    subjectId: "subj.mix-ratify.ok",
    deviceId: "dev-mix-ratify",
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(signed.ok, true, JSON.stringify(signed));
  if (!signed.ok) return;
  assert.equal(signed.mixPolicyVersion, versioned.mixPolicyVersion);
  assert.equal(signed.signoff.status, "ratified");
  assert.ok(signed.signoff.stakeholders.length >= MIX_POLICY_MIN_STAKEHOLDERS);
  for (const role of MIX_POLICY_REQUIRED_STAKEHOLDER_ROLES) {
    assert.ok(
      signed.signoff.stakeholders.some((s) => s.role === role),
      `missing role ${role}`,
    );
  }
  assert.ok(signed.signoff.changelog.length >= 1);
  assert.ok(events.some((e) => e.op === "signoff" && e.outcome === "ok"));
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test("happy path: promotion-ready golden manifest promotes", () => {
  const events = [];
  const result = assertMixPolicyPromotionFile(
    path.join(FIXTURES, MIX_POLICY_LINT_OK_REPAIR),
    {
      packageRoot: PKG_ROOT,
      subjectId: "subj.mix-ratify.promote",
      deviceId: "dev-mix-ratify",
      onTelemetry: (e) => events.push(e),
    },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.match(result.mixPolicyVersion, /^sha256:[a-f0-9]{64}$/);
  assert.ok(events.some((e) => e.op === "promote" && e.outcome === "ok"));
});

test("edge: version mismatch blocks promotion", () => {
  const events = [];
  const result = assertMixPolicyPromotionFile(
    path.join(FIXTURES, MIX_POLICY_LINT_VIOLATION_VERSION),
    {
      packageRoot: PKG_ROOT,
      subjectId: "subj.mix-ratify.mismatch",
      deviceId: "dev-mix-ratify",
      onTelemetry: (e) => events.push(e),
    },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failureClass, "version_mismatch");
  assert.ok(
    events.some((e) => e.op === "promote" && e.failureClass === "version_mismatch"),
  );
});

test("edge: missing mixPolicyVersion blocks promotion", () => {
  const loaded = loadCorpusManifestFile(
    path.join(PKG_ROOT, "fixtures", "valid", "minimal.json"),
    { subjectId: "subj.mix-ratify.nov", deviceId: "dev-mix-ratify" },
  );
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  assert.equal(loaded.value.mixPolicyVersion, undefined);

  const result = assertMixPolicyPromotion(loaded.value, {
    packageRoot: PKG_ROOT,
    subjectId: "subj.mix-ratify.nov",
    deviceId: "dev-mix-ratify",
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failureClass, "promotion_blocked");
});

test("edge: floating mixPolicyVersion 'latest' rejected", () => {
  const loaded = loadCorpusManifestFile(
    path.join(FIXTURES, MIX_POLICY_LINT_OK_REPAIR),
    { subjectId: "subj.mix-ratify.latest", deviceId: "dev-mix-ratify" },
  );
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  const poisoned = {
    ...loaded.value,
    mixPolicyVersion: "latest",
  };
  // Bypass schema by calling promotion with a cast — validate floating reject path.
  const result = assertMixPolicyPromotion(
    /** @type {import("../dist/build.js").CorpusManifest} */ (poisoned),
    {
      packageRoot: PKG_ROOT,
      subjectId: "subj.mix-ratify.latest",
      deviceId: "dev-mix-ratify",
    },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failureClass, "version_mismatch");
});

test("sovereignty: subject-scoped replay is idempotent; no raw content", () => {
  const a = assertMixPolicySignoff({
    packageRoot: PKG_ROOT,
    subjectId: "subj.mix-ratify.a",
    deviceId: "dev-a",
  });
  const b = assertMixPolicySignoff({
    packageRoot: PKG_ROOT,
    subjectId: "subj.mix-ratify.a",
    deviceId: "dev-a",
  });
  assert.deepEqual(a, b);
  assert.equal(a.ok, true);

  const other = assertMixPolicySignoff({
    packageRoot: PKG_ROOT,
    subjectId: "subj.mix-ratify.b",
    deviceId: "dev-b",
  });
  assert.equal(other.ok, true);
  if (!a.ok || !other.ok) return;
  assert.equal(a.mixPolicyVersion, other.mixPolicyVersion);
  assert.notEqual(a.subjectId, other.subjectId);

  const loaded = loadMixPolicySignoff({ packageRoot: PKG_ROOT });
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  assert.ok(loaded.absPath.replace(/\\/g, "/").endsWith(MIX_POLICY_SIGNOFF_RELPATH));
  assert.ok(!JSON.stringify(loaded.signoff).includes(SECRET));
});

test("prove: ratification CI gate green + version-mismatch red", () => {
  const events = [];
  const first = proveMixPolicyRatification({
    packageRoot: PKG_ROOT,
    subjectId: "subj.mix-ratify.prove",
    deviceId: "dev-mix-ratify",
    onTelemetry: (e) => events.push(e),
  });
  const second = proveMixPolicyRatification({
    packageRoot: PKG_ROOT,
    subjectId: "subj.mix-ratify.prove",
    deviceId: "dev-mix-ratify",
  });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.deepEqual(first, second);
  assert.ok(events.some((e) => e.op === "prove_ratify" && e.outcome === "ok"));
});
