/**
 * Federated aggregation policy — default-deny + upload gate (B9 locality).
 * Run: pnpm --filter @moolam/learning build && node --test packages/learning/tests/federated_policy.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FEDERATED_LOCALITY_PROOF_SCHEMA_VERSION,
  FEDERATION_DP_PARAMS,
  assertFederatedAggregationPolicyCoherent,
  assertFederatedAnonymizationProof,
  evaluateFederatedAggregationEligibility,
  proveFederatedDefaultDenyWorkedExamples,
  proveFederatedUploadGate,
  resetFederatedPolicyReceipts,
  runFederatedUploadGate,
} from "../dist/federated_policy.js";
import { SubjectConsentLedger } from "../dist/consent_gate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const DEVICE_ID = "device.federated.policy.test";

test("happy path: policy coherent; cross-tenant research_anon allows", async () => {
  resetFederatedPolicyReceipts();
  const events = [];
  const coherent = await assertFederatedAggregationPolicyCoherent({
    repoRoot: REPO_ROOT,
    deviceId: DEVICE_ID,
    onTelemetry: (event) => events.push(event),
  });
  assert.equal(coherent.ok, true, coherent.ok === false ? coherent.detail : "");

  const allow = evaluateFederatedAggregationEligibility({
    request: {
      operationId: "op.fed.allow",
      subjectId: "tenant.aurora.learner-01",
      deviceId: DEVICE_ID,
      locality: "self-hosted",
      federationTier: "research_anon",
      consentClass: "research",
      optedIn: true,
      anonymized: true,
      dp: FEDERATION_DP_PARAMS.research_anon,
      bundle: { featureHash: "sha256:abc", count: 4 },
    },
    onTelemetry: (event) => events.push(event),
  });
  assert.equal(allow.ok, true);
  if (allow.ok) {
    assert.equal(allow.federationTier, "research_anon");
    assert.match(allow.participantToken, /^participant\./);
    assert.equal(allow.idempotentReplay, false);
  }

  const replay = evaluateFederatedAggregationEligibility({
    request: {
      operationId: "op.fed.allow",
      subjectId: "tenant.aurora.learner-01",
      deviceId: DEVICE_ID,
      locality: "self-hosted",
      federationTier: "research_anon",
      consentClass: "research",
      optedIn: true,
      anonymized: true,
      dp: FEDERATION_DP_PARAMS.research_anon,
    },
  });
  assert.equal(replay.ok, true);
  if (replay.ok) assert.equal(replay.idempotentReplay, true);

  assert.ok(events.some((event) => event.action === "assert_policy"));
  assert.ok(!JSON.stringify(events).includes("utterance"));
});

test("edge: default deny, personal forbidden, undeclared DP, revoke, raw content", async () => {
  resetFederatedPolicyReceipts();
  const events = [];

  const denied = evaluateFederatedAggregationEligibility({
    request: {
      operationId: "op.fed.deny",
      subjectId: "tenant.x.learner-1",
      deviceId: DEVICE_ID,
      locality: "self-hosted",
      consentClass: "research",
      optedIn: true,
      anonymized: true,
      dp: FEDERATION_DP_PARAMS.research_anon,
    },
    onTelemetry: (event) => events.push(event),
  });
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.failureClass, "federated.default_deny");

  const personal = evaluateFederatedAggregationEligibility({
    request: {
      operationId: "op.fed.personal",
      subjectId: "tenant.x.learner-2",
      deviceId: DEVICE_ID,
      locality: "on-device",
      federationTier: "research_anon",
      consentClass: "personal",
      optedIn: true,
      anonymized: true,
      dp: FEDERATION_DP_PARAMS.research_anon,
    },
    onTelemetry: (event) => events.push(event),
  });
  assert.equal(personal.ok, false);
  if (!personal.ok) {
    assert.equal(personal.failureClass, "federated.personal_forbidden");
  }

  const undeclared = evaluateFederatedAggregationEligibility({
    request: {
      operationId: "op.fed.undeclared",
      subjectId: "tenant.x.learner-3",
      deviceId: DEVICE_ID,
      locality: "self-hosted",
      federationTier: "product_improve_anon",
      consentClass: "product-improve",
      optedIn: true,
      anonymized: true,
    },
    onTelemetry: (event) => events.push(event),
  });
  assert.equal(undeclared.ok, false);
  if (!undeclared.ok) {
    assert.equal(undeclared.failureClass, "federated.dp_undeclared");
  }

  const ledger = new SubjectConsentLedger();
  ledger.revoke("tenant.x.learner-revoked");
  const revoked = evaluateFederatedAggregationEligibility({
    request: {
      operationId: "op.fed.round",
      subjectId: "tenant.x.learner-revoked",
      deviceId: DEVICE_ID,
      locality: "self-hosted",
      federationTier: "research_anon",
      consentClass: "research",
      optedIn: true,
      anonymized: true,
      dp: FEDERATION_DP_PARAMS.research_anon,
    },
    ledger,
    onTelemetry: (event) => events.push(event),
  });
  assert.equal(revoked.ok, false);
  if (!revoked.ok) {
    assert.equal(revoked.failureClass, "federated.consent_revoked");
  }

  const raw = assertFederatedAnonymizationProof({
    anonymized: true,
    bundle: { replyBody: "secret learner text" },
    subjectId: "tenant.x.learner-4",
    deviceId: DEVICE_ID,
    onTelemetry: (event) => events.push(event),
  });
  assert.equal(raw.ok, false);
  if (!raw.ok) assert.equal(raw.failureClass, "federated.sovereignty");

  assert.ok(
    events.some((event) => event.failureClass === "federated.default_deny"),
  );
  assert.ok(
    events.some(
      (event) => event.failureClass === "federated.personal_forbidden",
    ),
  );
});

test("integration: proveFederatedDefaultDenyWorkedExamples", async () => {
  const events = [];
  const proved = await proveFederatedDefaultDenyWorkedExamples({
    repoRoot: REPO_ROOT,
    deviceId: DEVICE_ID,
    onTelemetry: (event) => events.push(event),
  });
  assert.equal(proved.ok, true);
  assert.equal(proved.missingTierDenied, true);
  assert.equal(proved.personalForbidden, true);
  assert.equal(proved.dpUndeclared, true);
  assert.equal(proved.revokedExcluded, true);
  assert.equal(proved.rawContentDenied, true);
  assert.equal(proved.crossTenantAllowed, true);
  assert.equal(proved.policyCoherent, true);
  assert.ok(
    events.some(
      (event) =>
        event.action === "worked_example" &&
        event.exampleId === "cross_tenant_allow",
    ),
  );
  assert.ok(!JSON.stringify(events).includes("must never leave locality"));
});

test("upload gate: admits metadata upload; missing proof / raw / third-party deny", async () => {
  resetFederatedPolicyReceipts();
  const events = [];
  const proved = await proveFederatedUploadGate({
    deviceId: DEVICE_ID,
    onTelemetry: (event) => events.push(event),
  });
  assert.equal(proved.ok, true);
  assert.equal(proved.accepted, true);
  assert.equal(proved.missingProofDenied, true);
  assert.equal(proved.rawContentDenied, true);
  assert.equal(proved.thirdPartyDenied, true);
  assert.equal(proved.defaultDenyMissingTier, true);
  assert.equal(proved.subjectIsolated, true);
  assert.equal(proved.idempotentReplay, true);

  assert.ok(
    events.some(
      (event) => event.action === "upload_gate" && event.outcome === "ok",
    ),
  );
  assert.ok(
    events.some(
      (event) => event.failureClass === "federated.locality_proof_missing",
    ),
  );
  assert.ok(!JSON.stringify(events).includes("raw subject content"));
});

test("upload gate: locality proof binding + revoked mid-aggregation", async () => {
  resetFederatedPolicyReceipts();
  const subjectId = "tenant.aurora.learner-bind";
  const proof = {
    schemaVersion: FEDERATED_LOCALITY_PROOF_SCHEMA_VERSION,
    subjectId,
    deviceId: DEVICE_ID,
    locality: "self-hosted",
    destinationClass: "self-hosted",
    payloadClass: "metadata",
    egressObserved: true,
    destinationHostClass: "self-hosted-allowlist",
    completedAt: "2026-07-17T15:10:00.000Z",
  };

  const mismatched = await runFederatedUploadGate({
    request: {
      operationId: "op.fed.upload.bind",
      subjectId,
      deviceId: DEVICE_ID,
      locality: "self-hosted",
      federationTier: "research_anon",
      consentClass: "research",
      optedIn: true,
      anonymized: true,
      dp: FEDERATION_DP_PARAMS.research_anon,
      bundle: { featureHash: "sha256:bind" },
    },
    localityProof: { ...proof, subjectId: "tenant.other" },
  });
  assert.equal(mismatched.ok, false);
  if (!mismatched.ok) {
    assert.equal(mismatched.failureClass, "federated.cross_subject");
  }

  const ledger = new SubjectConsentLedger();
  ledger.revoke(subjectId);
  const revoked = await runFederatedUploadGate({
    request: {
      operationId: "op.fed.upload.revoked",
      subjectId,
      deviceId: DEVICE_ID,
      locality: "self-hosted",
      federationTier: "research_anon",
      consentClass: "research",
      optedIn: true,
      anonymized: true,
      dp: FEDERATION_DP_PARAMS.research_anon,
      bundle: { featureHash: "sha256:revoked" },
    },
    localityProof: proof,
    ledger,
  });
  assert.equal(revoked.ok, false);
  if (!revoked.ok) {
    assert.equal(revoked.failureClass, "federated.consent_revoked");
  }
});
