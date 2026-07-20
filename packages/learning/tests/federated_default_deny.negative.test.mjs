/**
 * Federated default-deny negative fixture suite.
 * Fixtures: missing consent, raw content leak, wrong anonymization tier —
 * each blocked; only the fully proven bundle accepts upload.
 *
 * Run: pnpm --filter @moolam/learning build && node --test packages/learning/tests/federated_default_deny.negative.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FEDERATED_DEFAULT_DENY_SUITE_FIXTURE,
  loadFederatedDefaultDenySuite,
  proveFederatedDefaultDenyNegativeSuite,
  resetFederatedPolicyReceipts,
} from "../dist/federated_policy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const DEVICE_ID = "device.federated.negative.test";

test("happy path: only fully proven fixture accepts upload", async () => {
  resetFederatedPolicyReceipts();
  const events = [];
  const proved = await proveFederatedDefaultDenyNegativeSuite({
    repoRoot: REPO_ROOT,
    deviceId: DEVICE_ID,
    onTelemetry: (event) => events.push(event),
  });

  assert.equal(proved.ok, true);
  assert.equal(proved.suiteId, "federated.default-deny.negative");
  assert.equal(proved.caseCount, 6);
  assert.equal(proved.provenAccepted, true);
  assert.equal(proved.onlyProvenAccepted, true);
  assert.equal(proved.subjectIsolated, true);

  assert.ok(
    events.some(
      (event) =>
        event.exampleId === "proven-accept" && event.outcome === "ok",
    ),
  );
  assert.ok(!JSON.stringify(events).includes("RAW_LEARNER_CONTENT"));
});

test("edge: missing consent, raw leak, wrong anonymization each blocked", async () => {
  resetFederatedPolicyReceipts();
  const events = [];
  const proved = await proveFederatedDefaultDenyNegativeSuite({
    repoRoot: REPO_ROOT,
    deviceId: DEVICE_ID,
    onTelemetry: (event) => events.push(event),
  });

  assert.equal(proved.missingConsentBlocked, true);
  assert.equal(proved.rawContentBlocked, true);
  assert.equal(proved.wrongAnonymizationBlocked, true);
  assert.equal(proved.consentTierMismatchBlocked, true);
  assert.equal(proved.missingLocalityProofBlocked, true);

  assert.ok(
    events.some(
      (event) =>
        event.exampleId === "missing-consent" &&
        event.failureClass === "federated.default_deny",
    ),
  );
  assert.ok(
    events.some(
      (event) =>
        event.exampleId === "raw-content-leak" &&
        event.failureClass === "federated.sovereignty",
    ),
  );
  assert.ok(
    events.some(
      (event) =>
        event.exampleId === "wrong-anonymization-tier" &&
        event.failureClass === "federated.anonymization_missing",
    ),
  );
});

test("sovereignty: suite fixture loads without raw prose outside named leak case", async () => {
  const loaded = await loadFederatedDefaultDenySuite({
    repoRoot: REPO_ROOT,
    deviceId: DEVICE_ID,
  });
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;

  assert.equal(loaded.document.cases.length, 6);
  const rejectCases = loaded.document.cases.filter((c) => c.expect === "reject");
  const acceptCases = loaded.document.cases.filter((c) => c.expect === "accept");
  assert.equal(acceptCases.length, 1);
  assert.equal(acceptCases[0]?.caseId, "proven-accept");
  assert.ok(rejectCases.length >= 3);
  assert.ok(
    rejectCases.some((c) => c.caseId === "missing-consent"),
  );
  assert.ok(rejectCases.some((c) => c.caseId === "raw-content-leak"));
  assert.ok(
    rejectCases.some((c) => c.caseId === "wrong-anonymization-tier"),
  );

  const raw = rejectCases.find((c) => c.caseId === "raw-content-leak");
  assert.ok(raw?.request.bundle && "utterance" in raw.request.bundle);

  for (const c of loaded.document.cases) {
    if (c.caseId === "raw-content-leak") continue;
    assert.ok(
      !JSON.stringify(c.request.bundle ?? {}).includes("RAW_LEARNER"),
      `${c.caseId} must not carry raw learner prose`,
    );
  }

  assert.equal(
    FEDERATED_DEFAULT_DENY_SUITE_FIXTURE,
    "default-deny-negative-suite.json",
  );
});
