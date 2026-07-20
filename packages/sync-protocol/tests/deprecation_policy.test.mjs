/**
 * Deprecation policy consistency.
 *
 * Happy path: policy exists, linked from package README + public protocol docs.
 * Edge: concrete window (180 days / two minors) and three worked examples present.
 * Edge: breaking renames of subjectId deferred; sovereignty (no raw learner content).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(PKG_ROOT, "..", "..");
const POLICY = path.join(PKG_ROOT, "docs", "DEPRECATION-POLICY.md");
const README = path.join(PKG_ROOT, "README.md");
const PROTOCOL_DOCS = path.join(REPO_ROOT, "docs", "protocol", "README.md");
const IMPLEMENTOR_GUIDE = path.join(
  REPO_ROOT,
  "docs",
  "protocol",
  "DEPRECATION-POLICY.md",
);
const SDK_README = path.join(REPO_ROOT, "docs", "sdk", "README.md");
const FREEZE_RFC = path.join(REPO_ROOT, "rfcs", "0001-protocol-1.0-freeze.md");
const CONTRACT = path.join(PKG_ROOT, "src", "contract.ts");

test("happy path: deprecation policy published and linked", async () => {
  const policy = await readFile(POLICY, "utf8");
  const readme = await readFile(README, "utf8");
  const protocol = await readFile(PROTOCOL_DOCS, "utf8");

  assert.match(policy, /Additive-only/i);
  assert.match(policy, /PROTOCOL_VERSION/);
  assert.match(policy, /180/);
  assert.match(readme, /DEPRECATION-POLICY\.md/);
  assert.match(protocol, /DEPRECATION-POLICY\.md/);
});

test("edge: three worked examples + Stage 3 deferral for breaking renames", async () => {
  const policy = await readFile(POLICY, "utf8");

  assert.match(policy, /Example A/i);
  assert.match(policy, /Example B/i);
  assert.match(policy, /Example C/i);
  assert.match(policy, /sourceDeviceClass/);
  assert.match(policy, /legacyLocale/);
  assert.match(policy, /subjectId/);
  assert.match(policy, /learnerId/);
  assert.match(policy, /Stage 3/);
  assert.match(policy, /two.*minor/i);

  // Concurrent / idempotent sync identity stays subject-scoped in policy text.
  assert.match(policy, /syncAttemptId/);
  assert.match(policy, /SUBJECT_MISMATCH|subject-scoped|subjectId/i);
});

test("edge: policy examples name real baseline wire fields; no content exfil claims", async () => {
  const policy = await readFile(POLICY, "utf8");
  const contract = await readFile(CONTRACT, "utf8");

  assert.match(contract, /export interface FrictionSample|frictionSampleSchema/);
  assert.match(contract, /subjectId/);
  assert.match(contract, /PROTOCOL_VERSION = "1\.0\.0"/);
  assert.match(contract, /DEPRECATED_FIELD_PRESENT/);
  assert.match(policy, /FrictionSample/);
  assert.match(policy, /profile\.language/);
  assert.match(policy, /DEPRECATED_FIELD_PRESENT/);
  assert.match(policy, /__deprTestLegacyLocale/);
  assert.match(policy, /2027-01-13/);
  assert.doesNotMatch(policy, /\bexfiltrat/i);
  assert.doesNotMatch(policy, /raw (utterance|keystroke) text in (logs|changelog)/i);
});

test("happy path: post-1.0 implementor guide is linked from freeze RFC and SDK", async () => {
  const [guide, sdk, rfc] = await Promise.all([
    readFile(IMPLEMENTOR_GUIDE, "utf8"),
    readFile(SDK_README, "utf8"),
    readFile(FREEZE_RFC, "utf8"),
  ]);

  assert.match(guide, /^# Post-1\.0 protocol evolution guide/m);
  assert.match(guide, /packages\/sync-protocol\/docs\/DEPRECATION-POLICY\.md/);
  assert.match(sdk, /\.\.\/protocol\/DEPRECATION-POLICY\.md/);
  assert.match(rfc, /\.\.\/docs\/protocol\/DEPRECATION-POLICY\.md/);
});

test("edge: guide fails closed on unsupported versions and preserves replay isolation", async () => {
  const guide = await readFile(IMPLEMENTOR_GUIDE, "utf8");

  assert.match(guide, /same major, newer minor/i);
  assert.match(guide, /different major/i);
  assert.match(guide, /reject or quarantine/i);
  assert.match(guide, /literal-pinned validator/i);
  assert.match(guide, /syncAttemptId/);
  assert.match(guide, /partial failure/i);
  assert.match(guide, /two distinct `subjectId`/);
  assert.match(guide, /deviceId.*not authorization/i);
  assert.match(guide, /bounded/i);
});

test("edge: guide keeps deprecated values private through the full migration window", async () => {
  const guide = await readFile(IMPLEMENTOR_GUIDE, "utf8");

  assert.match(guide, /DEPRECATED_FIELD_PRESENT/);
  assert.match(guide, /sunset=YYYY-MM-DD/);
  assert.match(guide, /2027-01-13/);
  assert.match(guide, /180 days/);
  assert.match(guide, /two\s+subsequent minor bumps/);
  assert.match(guide, /Readers keep\s+accepting and preserving it/i);
  assert.match(guide, /writers stop creating it/i);
  assert.match(guide, /metadata-only/i);
  assert.match(guide, /must never carry field values/i);
  assert.doesNotMatch(guide, /log (the )?(complete|full) payload/i);
});
