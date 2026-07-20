/**
 * Federated aggregation policy — machine mirror of
 * training/federated/aggregation_policy.md (constitution L5).
 *
 * Anonymization and default-deny are executable here — not policy prose alone.
 * The federated upload gate extends B9 locality obligations: no raw subject
 * content leaves the declared boundary; missing locality proof is default-deny.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  SubjectConsentLedger,
  isConsentClass,
  type ConsentClass,
} from "./consent_gate.js";

/** Repo-relative ratified policy document. */
export const FEDERATED_AGGREGATION_POLICY_RELPATH =
  "training/federated/aggregation_policy.md" as const;

/** Parent constitution (C0) that must link this policy. */
export const FEDERATED_POLICY_CONSTITUTION_RELPATH =
  "docs/learning/CONSTITUTION.md" as const;

export const FEDERATED_POLICY_SCHEMA_VERSION =
  "federated.aggregation-policy.v1" as const;

/** Soft caps (NFR — bounded participant sets / DP pins / receipts). */
export const FEDERATED_POLICY_PARTICIPANT_LIMIT = 256 as const;
export const FEDERATED_POLICY_OPERATION_LIMIT = 512 as const;
export const FEDERATED_POLICY_PHRASE_LIMIT = 32 as const;

/**
 * Federation consent tiers. Absence / unknown → default deny.
 * `personal` is never a valid federation tier.
 */
export const FEDERATION_CONSENT_TIERS = Object.freeze([
  "research_anon",
  "product_improve_anon",
] as const);

export type FederationConsentTier = (typeof FEDERATION_CONSENT_TIERS)[number];

export const FEDERATION_ELIGIBLE_TIERS = FEDERATION_CONSENT_TIERS;

/** Map federation tier → required B9 consent class. */
export const FEDERATION_TIER_TO_CONSENT_CLASS = Object.freeze({
  research_anon: "research",
  product_improve_anon: "product-improve",
} as const satisfies Record<FederationConsentTier, ConsentClass>);

export type FederatedDpParams = {
  epsilon: number;
  delta: number;
  clipNorm: number;
};

/**
 * Declared DP pins per eligible tier. Uploads must meet or beat (stricter)
 * these values; looser noise rejects.
 */
export const FEDERATION_DP_PARAMS = Object.freeze({
  research_anon: Object.freeze({
    epsilon: 1.0,
    delta: 1e-5,
    clipNorm: 1.0,
  }),
  product_improve_anon: Object.freeze({
    epsilon: 0.5,
    delta: 1e-6,
    clipNorm: 1.0,
  }),
} as const satisfies Record<FederationConsentTier, FederatedDpParams>);

export type FederatedPolicyFailureClass =
  | "federated.default_deny"
  | "federated.personal_forbidden"
  | "federated.dp_undeclared"
  | "federated.dp_too_loose"
  | "federated.consent_revoked"
  | "federated.consent_mismatch"
  | "federated.anonymization_missing"
  | "federated.sovereignty"
  | "federated.locality_forbidden"
  | "federated.locality_proof_missing"
  | "federated.locality_egress"
  | "federated.cross_subject"
  | "federated.missing_subject"
  | "federated.invalid_input"
  | "federated.section_limit"
  | "federated.policy_gap"
  | "federated.idempotent_conflict"
  | "federated.partial_failure"
  | "federated.downstream_timeout"
  | "federated.capacity";

export class FederatedPolicyError extends Error {
  readonly obligation: FederatedPolicyFailureClass;
  readonly subjectId: string | undefined;
  readonly deviceId: string | undefined;

  constructor(
    message: string,
    meta: {
      obligation: FederatedPolicyFailureClass;
      subjectId?: string;
      deviceId?: string;
    },
  ) {
    super(message);
    this.name = "FederatedPolicyError";
    this.obligation = meta.obligation;
    this.subjectId = meta.subjectId;
    this.deviceId = meta.deviceId;
  }
}

export type FederatedPolicyTelemetryEvent = {
  event: "learning.federated.policy";
  outcome: "ok" | "rejected" | "idempotent_replay";
  subjectId: string | null;
  deviceId?: string;
  action?:
    | "evaluate"
    | "assert_policy"
    | "assert_anonymization"
    | "worked_example"
    | "revoke_round"
    | "upload_gate"
    | "locality_proof";
  failureClass?: FederatedPolicyFailureClass;
  federationTier?: FederationConsentTier;
  operationId?: string;
  exampleId?: string;
};

export type FederatedAggregationRequest = {
  operationId: string;
  subjectId: string;
  deviceId: string;
  locality: "on-device" | "self-hosted";
  /** Absent / unknown → default deny. */
  federationTier?: string | null;
  consentClass?: string | null;
  optedIn?: boolean;
  anonymized?: boolean;
  /** Required for eligible tiers — undeclared rejects. */
  dp?: Partial<FederatedDpParams> | null;
  /**
   * Metadata-only upload fields. Forbidden content keys void sovereignty.
   * Values must be hashes, counts, or opaque tokens — never raw text bodies.
   */
  bundle?: Record<string, unknown>;
};

export type FederatedAggregationDecision =
  | {
      ok: true;
      subjectId: string;
      federationTier: FederationConsentTier;
      dp: FederatedDpParams;
      participantToken: string;
      idempotentReplay: boolean;
    }
  | {
      ok: false;
      subjectId: string | null;
      failureClass: FederatedPolicyFailureClass;
      detail: string;
    };

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const FORBIDDEN_CONTENT_KEY =
  /utterance|promptBody|replyBody|learnerContent|rawContent|secret/i;

const eligibilityReceipts = new Map<string, FederatedAggregationDecision>();

/** Phrases that must remain in the ratified markdown (worked examples). */
export const FEDERATED_POLICY_REQUIRED_PHRASES = Object.freeze([
  "Default deny",
  "Consent tiers",
  "Anonymization requirements",
  "Differential privacy parameters",
  "Missing consent tier",
  "Personal consent never federates",
  "Undeclared DP parameters",
  "Revoked mid-aggregation",
  "Raw content in bundle",
  "Real cross-tenant scenario walkthrough",
  "Federated upload gate",
  "B9 locality",
  "research_anon",
  "product_improve_anon",
] as const);

export type FederatedWorkedExampleId =
  | "missing_tier_deny"
  | "personal_forbidden"
  | "dp_undeclared"
  | "revoked_mid_round"
  | "raw_content_sovereignty"
  | "cross_tenant_allow";

function emit(
  onTelemetry: ((e: FederatedPolicyTelemetryEvent) => void) | undefined,
  event: FederatedPolicyTelemetryEvent,
): void {
  onTelemetry?.(event);
}

function isFederationTier(value: unknown): value is FederationConsentTier {
  return (
    typeof value === "string" &&
    (FEDERATION_CONSENT_TIERS as readonly string[]).includes(value)
  );
}

function participantToken(subjectId: string, operationId: string): string {
  // Opaque token — never embed the raw subject id in upload identities.
  let hash = 0;
  const material = `${operationId}|${subjectId}`;
  for (let i = 0; i < material.length; i += 1) {
    hash = (hash * 33 + material.charCodeAt(i)) >>> 0;
  }
  return `participant.${hash.toString(16).padStart(8, "0")}`;
}

/**
 * Executable anonymization proof: metadata-only bundle, no raw content keys.
 */
export function assertFederatedAnonymizationProof(input: {
  anonymized: boolean;
  bundle?: Record<string, unknown>;
  subjectId?: string;
  deviceId?: string;
  onTelemetry?: (e: FederatedPolicyTelemetryEvent) => void;
}):
  | { ok: true }
  | { ok: false; failureClass: FederatedPolicyFailureClass; detail: string } {
  if (input.anonymized !== true) {
    emit(input.onTelemetry, {
      event: "learning.federated.policy",
      outcome: "rejected",
      subjectId: input.subjectId ?? null,
      ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      action: "assert_anonymization",
      failureClass: "federated.anonymization_missing",
    });
    return {
      ok: false,
      failureClass: "federated.anonymization_missing",
      detail: "federation requires anonymized=true",
    };
  }
  if (input.bundle !== undefined) {
    const keys = Object.keys(input.bundle);
    if (keys.length > FEDERATED_POLICY_PARTICIPANT_LIMIT) {
      return {
        ok: false,
        failureClass: "federated.section_limit",
        detail: `bundle fields exceed ${FEDERATED_POLICY_PARTICIPANT_LIMIT}`,
      };
    }
    for (const key of keys) {
      if (FORBIDDEN_CONTENT_KEY.test(key)) {
        emit(input.onTelemetry, {
          event: "learning.federated.policy",
          outcome: "rejected",
          subjectId: input.subjectId ?? null,
          ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
          action: "assert_anonymization",
          failureClass: "federated.sovereignty",
        });
        return {
          ok: false,
          failureClass: "federated.sovereignty",
          detail: `bundle forbids raw content field ${key}`,
        };
      }
      const value = input.bundle[key];
      if (typeof value === "string" && value.length > 256) {
        return {
          ok: false,
          failureClass: "federated.sovereignty",
          detail: `bundle field ${key} exceeds metadata length budget`,
        };
      }
    }
  }
  emit(input.onTelemetry, {
    event: "learning.federated.policy",
    outcome: "ok",
    subjectId: input.subjectId ?? null,
    ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
    action: "assert_anonymization",
  });
  return { ok: true };
}

function dpMeetsOrBeats(
  declared: FederatedDpParams,
  pin: FederatedDpParams,
): boolean {
  return (
    declared.epsilon <= pin.epsilon + Number.EPSILON &&
    declared.delta <= pin.delta + Number.EPSILON &&
    declared.clipNorm <= pin.clipNorm + Number.EPSILON
  );
}

/**
 * Evaluate whether a subject may contribute to a federated aggregation round.
 * Default deny when tier / anonymization / DP / consent are incomplete.
 */
export function evaluateFederatedAggregationEligibility(input: {
  request: FederatedAggregationRequest;
  ledger?: SubjectConsentLedger;
  onTelemetry?: (e: FederatedPolicyTelemetryEvent) => void;
}): FederatedAggregationDecision {
  const req = input.request;
  const meta = {
    subjectId: req.subjectId,
    deviceId: req.deviceId,
  };

  if (!ID_RE.test(req.operationId) || !ID_RE.test(req.subjectId) || !ID_RE.test(req.deviceId)) {
    emit(input.onTelemetry, {
      event: "learning.federated.policy",
      outcome: "rejected",
      subjectId: req.subjectId || null,
      deviceId: req.deviceId,
      action: "evaluate",
      failureClass: "federated.invalid_input",
      operationId: req.operationId,
    });
    return {
      ok: false,
      subjectId: req.subjectId || null,
      failureClass: "federated.invalid_input",
      detail: "operation/subject/device ids must be stable metadata ids",
    };
  }

  if (req.locality !== "on-device" && req.locality !== "self-hosted") {
    return {
      ok: false,
      subjectId: req.subjectId,
      failureClass: "federated.locality_forbidden",
      detail: "invalid locality",
    };
  }

  const receiptKey = `${req.operationId}|${req.subjectId}|${req.deviceId}`;
  const prior = eligibilityReceipts.get(receiptKey);
  if (prior !== undefined) {
    emit(input.onTelemetry, {
      event: "learning.federated.policy",
      outcome: "idempotent_replay",
      subjectId: req.subjectId,
      deviceId: req.deviceId,
      action: "evaluate",
      operationId: req.operationId,
      ...(prior.ok ? { federationTier: prior.federationTier } : {}),
    });
    if (prior.ok) {
      return { ...prior, idempotentReplay: true };
    }
    return prior;
  }

  if (eligibilityReceipts.size >= FEDERATED_POLICY_OPERATION_LIMIT) {
    return {
      ok: false,
      subjectId: req.subjectId,
      failureClass: "federated.capacity",
      detail: "federated eligibility receipt capacity exceeded",
    };
  }

  if (input.ledger?.isRevoked(req.subjectId)) {
    const decision: FederatedAggregationDecision = {
      ok: false,
      subjectId: req.subjectId,
      failureClass: "federated.consent_revoked",
      detail: "subject revoked — excluded from current aggregation round",
    };
    eligibilityReceipts.set(receiptKey, decision);
    emit(input.onTelemetry, {
      event: "learning.federated.policy",
      outcome: "rejected",
      subjectId: req.subjectId,
      deviceId: req.deviceId,
      action: "revoke_round",
      failureClass: "federated.consent_revoked",
      operationId: req.operationId,
    });
    return decision;
  }

  if (req.consentClass === "personal") {
    const decision: FederatedAggregationDecision = {
      ok: false,
      subjectId: req.subjectId,
      failureClass: "federated.personal_forbidden",
      detail: "personal consent class never federates",
    };
    eligibilityReceipts.set(receiptKey, decision);
    emit(input.onTelemetry, {
      event: "learning.federated.policy",
      outcome: "rejected",
      subjectId: req.subjectId,
      deviceId: req.deviceId,
      action: "evaluate",
      failureClass: "federated.personal_forbidden",
      operationId: req.operationId,
    });
    return decision;
  }

  if (!isFederationTier(req.federationTier)) {
    const decision: FederatedAggregationDecision = {
      ok: false,
      subjectId: req.subjectId,
      failureClass: "federated.default_deny",
      detail: "cross-subject aggregation denied without explicit federation tier",
    };
    eligibilityReceipts.set(receiptKey, decision);
    emit(input.onTelemetry, {
      event: "learning.federated.policy",
      outcome: "rejected",
      subjectId: req.subjectId,
      deviceId: req.deviceId,
      action: "evaluate",
      failureClass: "federated.default_deny",
      operationId: req.operationId,
    });
    return decision;
  }

  const requiredClass = FEDERATION_TIER_TO_CONSENT_CLASS[req.federationTier];
  if (
    !isConsentClass(req.consentClass) ||
    req.consentClass !== requiredClass ||
    req.optedIn !== true
  ) {
    const decision: FederatedAggregationDecision = {
      ok: false,
      subjectId: req.subjectId,
      failureClass: "federated.consent_mismatch",
      detail: `tier ${req.federationTier} requires opted-in consentClass=${requiredClass}`,
    };
    eligibilityReceipts.set(receiptKey, decision);
    emit(input.onTelemetry, {
      event: "learning.federated.policy",
      outcome: "rejected",
      subjectId: req.subjectId,
      deviceId: req.deviceId,
      action: "evaluate",
      failureClass: "federated.consent_mismatch",
      federationTier: req.federationTier,
      operationId: req.operationId,
    });
    return decision;
  }

  const anon = assertFederatedAnonymizationProof({
    anonymized: req.anonymized === true,
    ...(req.bundle !== undefined ? { bundle: req.bundle } : {}),
    ...meta,
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });
  if (!anon.ok) {
    const decision: FederatedAggregationDecision = {
      ok: false,
      subjectId: req.subjectId,
      failureClass: anon.failureClass,
      detail: anon.detail,
    };
    eligibilityReceipts.set(receiptKey, decision);
    return decision;
  }

  if (req.dp === undefined || req.dp === null) {
    const decision: FederatedAggregationDecision = {
      ok: false,
      subjectId: req.subjectId,
      failureClass: "federated.dp_undeclared",
      detail: "eligible federation tier requires declared DP parameters",
    };
    eligibilityReceipts.set(receiptKey, decision);
    emit(input.onTelemetry, {
      event: "learning.federated.policy",
      outcome: "rejected",
      subjectId: req.subjectId,
      deviceId: req.deviceId,
      action: "evaluate",
      failureClass: "federated.dp_undeclared",
      federationTier: req.federationTier,
      operationId: req.operationId,
    });
    return decision;
  }

  const pin = FEDERATION_DP_PARAMS[req.federationTier];
  const declared: FederatedDpParams = {
    epsilon: Number(req.dp.epsilon),
    delta: Number(req.dp.delta),
    clipNorm: Number(req.dp.clipNorm),
  };
  if (
    !Number.isFinite(declared.epsilon) ||
    !Number.isFinite(declared.delta) ||
    !Number.isFinite(declared.clipNorm) ||
    declared.epsilon <= 0 ||
    declared.delta <= 0 ||
    declared.clipNorm <= 0
  ) {
    const decision: FederatedAggregationDecision = {
      ok: false,
      subjectId: req.subjectId,
      failureClass: "federated.dp_undeclared",
      detail: "DP parameters must be finite positive numbers",
    };
    eligibilityReceipts.set(receiptKey, decision);
    return decision;
  }
  if (!dpMeetsOrBeats(declared, pin)) {
    const decision: FederatedAggregationDecision = {
      ok: false,
      subjectId: req.subjectId,
      failureClass: "federated.dp_too_loose",
      detail: "declared DP is looser than the ratified tier pin",
    };
    eligibilityReceipts.set(receiptKey, decision);
    emit(input.onTelemetry, {
      event: "learning.federated.policy",
      outcome: "rejected",
      subjectId: req.subjectId,
      deviceId: req.deviceId,
      action: "evaluate",
      failureClass: "federated.dp_too_loose",
      federationTier: req.federationTier,
      operationId: req.operationId,
    });
    return decision;
  }

  const decision: FederatedAggregationDecision = {
    ok: true,
    subjectId: req.subjectId,
    federationTier: req.federationTier,
    dp: Object.freeze({ ...declared }),
    participantToken: participantToken(req.subjectId, req.operationId),
    idempotentReplay: false,
  };
  eligibilityReceipts.set(receiptKey, decision);
  emit(input.onTelemetry, {
    event: "learning.federated.policy",
    outcome: "ok",
    subjectId: req.subjectId,
    deviceId: req.deviceId,
    action: "evaluate",
    federationTier: req.federationTier,
    operationId: req.operationId,
  });
  return decision;
}

/** Clear eligibility + upload-gate receipts (tests only). */
export function resetFederatedPolicyReceipts(): void {
  eligibilityReceipts.clear();
  resetFederatedUploadGateState();
}

/**
 * Assert the ratified markdown + constitution L5 link stay coherent with
 * machine constants (tiers, DP pins, worked-example phrases).
 */
export async function assertFederatedAggregationPolicyCoherent(input: {
  repoRoot: string;
  deviceId?: string;
  onTelemetry?: (e: FederatedPolicyTelemetryEvent) => void;
}): Promise<
  | { ok: true }
  | { ok: false; failureClass: FederatedPolicyFailureClass; detail: string }
> {
  const policyPath = path.join(
    input.repoRoot,
    FEDERATED_AGGREGATION_POLICY_RELPATH,
  );
  const constitutionPath = path.join(
    input.repoRoot,
    FEDERATED_POLICY_CONSTITUTION_RELPATH,
  );

  let policyText: string;
  let constitutionText: string;
  try {
    policyText = await readFile(policyPath, "utf8");
    constitutionText = await readFile(constitutionPath, "utf8");
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : "failed to read policy docs";
    emit(input.onTelemetry, {
      event: "learning.federated.policy",
      outcome: "rejected",
      subjectId: null,
      ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      action: "assert_policy",
      failureClass: "federated.policy_gap",
    });
    return { ok: false, failureClass: "federated.policy_gap", detail };
  }

  if (FEDERATED_POLICY_REQUIRED_PHRASES.length > FEDERATED_POLICY_PHRASE_LIMIT) {
    return {
      ok: false,
      failureClass: "federated.section_limit",
      detail: "required phrase set exceeds soft cap",
    };
  }

  for (const phrase of FEDERATED_POLICY_REQUIRED_PHRASES) {
    if (!policyText.includes(phrase)) {
      emit(input.onTelemetry, {
        event: "learning.federated.policy",
        outcome: "rejected",
        subjectId: null,
        ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
        action: "assert_policy",
        failureClass: "federated.policy_gap",
      });
      return {
        ok: false,
        failureClass: "federated.policy_gap",
        detail: `aggregation policy missing required phrase: ${phrase}`,
      };
    }
  }

  for (const tier of FEDERATION_CONSENT_TIERS) {
    const pin = FEDERATION_DP_PARAMS[tier];
    if (
      !policyText.includes(String(pin.epsilon)) ||
      !policyText.includes(String(pin.delta)) ||
      !policyText.includes(String(pin.clipNorm))
    ) {
      return {
        ok: false,
        failureClass: "federated.policy_gap",
        detail: `policy doc missing DP pin for tier ${tier}`,
      };
    }
  }

  if (
    !constitutionText.includes("Cross-subject default-deny") ||
    !constitutionText.includes("training/federated/aggregation_policy.md")
  ) {
    emit(input.onTelemetry, {
      event: "learning.federated.policy",
      outcome: "rejected",
      subjectId: null,
      ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      action: "assert_policy",
      failureClass: "federated.policy_gap",
    });
    return {
      ok: false,
      failureClass: "federated.policy_gap",
      detail:
        "constitution L5 must link training/federated/aggregation_policy.md",
    };
  }

  emit(input.onTelemetry, {
    event: "learning.federated.policy",
    outcome: "ok",
    subjectId: null,
    ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
    action: "assert_policy",
  });
  return { ok: true };
}

export type FederatedDefaultDenyProof = {
  ok: true;
  missingTierDenied: boolean;
  personalForbidden: boolean;
  dpUndeclared: boolean;
  revokedExcluded: boolean;
  rawContentDenied: boolean;
  crossTenantAllowed: boolean;
  policyCoherent: boolean;
};

/**
 * Prove default-deny worked examples + one happy cross-tenant allow path.
 */
export async function proveFederatedDefaultDenyWorkedExamples(input: {
  repoRoot: string;
  deviceId?: string;
  onTelemetry?: (e: FederatedPolicyTelemetryEvent) => void;
}): Promise<FederatedDefaultDenyProof> {
  resetFederatedPolicyReceipts();
  const deviceId = input.deviceId ?? "device.federated.policy";
  const events: FederatedPolicyTelemetryEvent[] = [];
  const onTelemetry = (event: FederatedPolicyTelemetryEvent) => {
    events.push(event);
    input.onTelemetry?.(event);
  };

  const coherent = await assertFederatedAggregationPolicyCoherent({
    repoRoot: input.repoRoot,
    deviceId,
    onTelemetry,
  });

  const missing = evaluateFederatedAggregationEligibility({
    request: {
      operationId: "op.fed.missing-tier",
      subjectId: "tenant.aurora.learner-99",
      deviceId,
      locality: "self-hosted",
      consentClass: "research",
      optedIn: true,
      anonymized: true,
      dp: FEDERATION_DP_PARAMS.research_anon,
      bundle: { featureHash: "sha256:deadbeef" },
    },
    onTelemetry,
  });
  emit(onTelemetry, {
    event: "learning.federated.policy",
    outcome: "ok",
    subjectId: "tenant.aurora.learner-99",
    deviceId,
    action: "worked_example",
    exampleId: "missing_tier_deny",
  });

  const personal = evaluateFederatedAggregationEligibility({
    request: {
      operationId: "op.fed.personal",
      subjectId: "tenant.aurora.learner-01",
      deviceId,
      locality: "self-hosted",
      federationTier: "research_anon",
      consentClass: "personal",
      optedIn: true,
      anonymized: true,
      dp: FEDERATION_DP_PARAMS.research_anon,
    },
    onTelemetry,
  });

  const undeclared = evaluateFederatedAggregationEligibility({
    request: {
      operationId: "op.fed.dp-missing",
      subjectId: "tenant.borealis.learner-02",
      deviceId,
      locality: "self-hosted",
      federationTier: "research_anon",
      consentClass: "research",
      optedIn: true,
      anonymized: true,
      bundle: { aggregateNorm: 0.12 },
    },
    onTelemetry,
  });

  const ledger = new SubjectConsentLedger();
  ledger.revoke("tenant.borealis.learner-revoked", { deviceId });
  const revoked = evaluateFederatedAggregationEligibility({
    request: {
      operationId: "op.fed.round.2026-07-17",
      subjectId: "tenant.borealis.learner-revoked",
      deviceId,
      locality: "self-hosted",
      federationTier: "research_anon",
      consentClass: "research",
      optedIn: true,
      anonymized: true,
      dp: FEDERATION_DP_PARAMS.research_anon,
    },
    ledger,
    onTelemetry,
  });

  const raw = evaluateFederatedAggregationEligibility({
    request: {
      operationId: "op.fed.raw",
      subjectId: "tenant.aurora.learner-raw",
      deviceId,
      locality: "on-device",
      federationTier: "product_improve_anon",
      consentClass: "product-improve",
      optedIn: true,
      anonymized: true,
      dp: FEDERATION_DP_PARAMS.product_improve_anon,
      bundle: { utterance: "must never leave locality" },
    },
    onTelemetry,
  });

  const aurora = evaluateFederatedAggregationEligibility({
    request: {
      operationId: "op.fed.cross-tenant",
      subjectId: "tenant.aurora.learner-01",
      deviceId,
      locality: "self-hosted",
      federationTier: "research_anon",
      consentClass: "research",
      optedIn: true,
      anonymized: true,
      dp: FEDERATION_DP_PARAMS.research_anon,
      bundle: { featureHash: "sha256:aaa", participantCount: 1 },
    },
    onTelemetry,
  });
  const borealis = evaluateFederatedAggregationEligibility({
    request: {
      operationId: "op.fed.cross-tenant",
      subjectId: "tenant.borealis.learner-07",
      deviceId,
      locality: "self-hosted",
      federationTier: "research_anon",
      consentClass: "research",
      optedIn: true,
      anonymized: true,
      dp: { epsilon: 0.8, delta: 1e-5, clipNorm: 1.0 },
      bundle: { featureHash: "sha256:bbb", participantCount: 1 },
    },
    onTelemetry,
  });

  const proof: FederatedDefaultDenyProof = {
    ok: true,
    missingTierDenied:
      !missing.ok && missing.failureClass === "federated.default_deny",
    personalForbidden:
      !personal.ok && personal.failureClass === "federated.personal_forbidden",
    dpUndeclared:
      !undeclared.ok && undeclared.failureClass === "federated.dp_undeclared",
    revokedExcluded:
      !revoked.ok && revoked.failureClass === "federated.consent_revoked",
    rawContentDenied:
      !raw.ok && raw.failureClass === "federated.sovereignty",
    crossTenantAllowed: aurora.ok === true && borealis.ok === true,
    policyCoherent: coherent.ok === true,
  };

  if (!proof.crossTenantAllowed || !proof.policyCoherent) {
    throw new FederatedPolicyError(
      "federated default-deny worked examples failed to prove",
      { obligation: "federated.policy_gap", deviceId },
    );
  }

  emit(onTelemetry, {
    event: "learning.federated.policy",
    outcome: "ok",
    subjectId: null,
    deviceId,
    action: "worked_example",
    exampleId: "cross_tenant_allow",
  });

  if (JSON.stringify(events).includes("must never leave locality")) {
    throw new FederatedPolicyError(
      "telemetry must not echo raw learner content",
      { obligation: "federated.sovereignty", deviceId },
    );
  }

  return proof;
}

/* ────────────────────────────────────────────────────────────────────────
 * Federated upload gate — extends B9 locality harness obligations
 * ──────────────────────────────────────────────────────────────────────── */

export const FEDERATED_LOCALITY_PROOF_SCHEMA_VERSION =
  "federated.locality-proof.v1" as const;
export const FEDERATED_UPLOAD_GATE_SCHEMA_VERSION =
  "federated.upload-gate.v1" as const;
export const FEDERATED_UPLOAD_DEFAULT_TIMEOUT_MS = 5_000 as const;
export const FEDERATED_UPLOAD_RECEIPT_LIMIT = 512 as const;

/**
 * Payload classes mirrored from the B9 / contract-conformance locality harness.
 * Federated uploads may only carry `metadata` after anonymization.
 */
export const FEDERATED_UPLOAD_PAYLOAD_CLASSES = Object.freeze([
  "none",
  "metadata",
  "cognitive-state",
  "regulated",
  "model-prompt",
  "unknown",
] as const);

export type FederatedUploadPayloadClass =
  (typeof FEDERATED_UPLOAD_PAYLOAD_CLASSES)[number];

export const FEDERATED_UPLOAD_DESTINATION_CLASSES = Object.freeze([
  "on-device",
  "self-hosted",
  "third-party",
] as const);

export type FederatedUploadDestinationClass =
  (typeof FEDERATED_UPLOAD_DESTINATION_CLASSES)[number];

/**
 * Locality proof attached to a federated upload attempt.
 * Missing proof → default deny (extends B9 harness fail-closed posture).
 */
export type FederatedLocalityProof = {
  schemaVersion: typeof FEDERATED_LOCALITY_PROOF_SCHEMA_VERSION;
  subjectId: string;
  deviceId: string;
  locality: "on-device" | "self-hosted";
  destinationClass: FederatedUploadDestinationClass;
  payloadClass: FederatedUploadPayloadClass;
  /** True when any network egress was observed during the upload attempt. */
  egressObserved: boolean;
  /** Opaque host class — never a URL with path/query secrets. */
  destinationHostClass: "self-hosted-allowlist" | "third-party" | "none";
  completedAt: string;
};

export type FederatedUploadAccepted = {
  ok: true;
  schemaVersion: typeof FEDERATED_UPLOAD_GATE_SCHEMA_VERSION;
  operationId: string;
  subjectId: string;
  deviceId: string;
  locality: "on-device" | "self-hosted";
  federationTier: FederationConsentTier;
  participantToken: string;
  dp: FederatedDpParams;
  /** Content-addressed receipt of the accepted metadata bundle (no raw fields). */
  bundleFingerprint: string;
  localityProof: FederatedLocalityProof;
  uploadedAt: string;
  idempotentReplay: boolean;
};

export type FederatedUploadRejected = {
  ok: false;
  schemaVersion: typeof FEDERATED_UPLOAD_GATE_SCHEMA_VERSION;
  operationId: string;
  subjectId: string | null;
  deviceId?: string;
  failureClass: FederatedPolicyFailureClass;
  detail: string;
};

export type FederatedUploadGateResult =
  | FederatedUploadAccepted
  | FederatedUploadRejected;

const uploadReceipts = new Map<string, FederatedUploadGateResult>();
const uploadSubjectLocks = new Set<string>();

function resetFederatedUploadGateState(): void {
  uploadReceipts.clear();
  uploadSubjectLocks.clear();
}

function fingerprintBundle(bundle: Record<string, unknown> | undefined): string {
  const keys = Object.keys(bundle ?? {}).sort();
  const material = keys
    .map((key) => `${key}:${JSON.stringify((bundle as Record<string, unknown>)[key])}`)
    .join("|");
  let hash = 2166136261;
  for (let i = 0; i < material.length; i += 1) {
    hash ^= material.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `sha256:fedupload${(hash >>> 0).toString(16).padStart(8, "0")}${"0".repeat(48)}`.slice(
    0,
    71,
  );
}

/**
 * Assert a B9-aligned locality proof for a federated upload.
 * Default deny when proof is missing; third-party / regulated egress fails.
 */
export function assertFederatedUploadLocalityProof(input: {
  request: FederatedAggregationRequest;
  localityProof: FederatedLocalityProof | null | undefined;
  onTelemetry?: (e: FederatedPolicyTelemetryEvent) => void;
}):
  | { ok: true; proof: FederatedLocalityProof }
  | { ok: false; failureClass: FederatedPolicyFailureClass; detail: string } {
  const req = input.request;
  if (input.localityProof == null) {
    emit(input.onTelemetry, {
      event: "learning.federated.policy",
      outcome: "rejected",
      subjectId: req.subjectId,
      deviceId: req.deviceId,
      action: "locality_proof",
      failureClass: "federated.locality_proof_missing",
      operationId: req.operationId,
    });
    return {
      ok: false,
      failureClass: "federated.locality_proof_missing",
      detail: "federated upload default-denies without a B9 locality proof",
    };
  }

  const proof = input.localityProof;
  if (proof.schemaVersion !== FEDERATED_LOCALITY_PROOF_SCHEMA_VERSION) {
    return {
      ok: false,
      failureClass: "federated.invalid_input",
      detail: "locality proof schemaVersion mismatch",
    };
  }
  if (
    proof.subjectId !== req.subjectId ||
    proof.deviceId !== req.deviceId
  ) {
    emit(input.onTelemetry, {
      event: "learning.federated.policy",
      outcome: "rejected",
      subjectId: req.subjectId,
      deviceId: req.deviceId,
      action: "locality_proof",
      failureClass: "federated.cross_subject",
      operationId: req.operationId,
    });
    return {
      ok: false,
      failureClass: "federated.cross_subject",
      detail: "locality proof subject/device does not match upload request",
    };
  }
  if (proof.locality !== req.locality) {
    return {
      ok: false,
      failureClass: "federated.locality_forbidden",
      detail: "locality proof boundary does not match upload request",
    };
  }
  if (
    !(FEDERATED_UPLOAD_PAYLOAD_CLASSES as readonly string[]).includes(
      proof.payloadClass,
    ) ||
    !(FEDERATED_UPLOAD_DESTINATION_CLASSES as readonly string[]).includes(
      proof.destinationClass,
    )
  ) {
    return {
      ok: false,
      failureClass: "federated.invalid_input",
      detail: "locality proof payload/destination class invalid",
    };
  }

  // Federated uploads carry anonymized metadata only — never regulated bodies.
  if (proof.payloadClass !== "metadata" && proof.payloadClass !== "none") {
    emit(input.onTelemetry, {
      event: "learning.federated.policy",
      outcome: "rejected",
      subjectId: req.subjectId,
      deviceId: req.deviceId,
      action: "locality_proof",
      failureClass: "federated.sovereignty",
      operationId: req.operationId,
    });
    return {
      ok: false,
      failureClass: "federated.sovereignty",
      detail: "federated upload payloadClass must be metadata (or none)",
    };
  }

  // Third-party destinations are never allowed for federated learning uploads.
  if (
    proof.destinationClass === "third-party" ||
    proof.destinationHostClass === "third-party"
  ) {
    emit(input.onTelemetry, {
      event: "learning.federated.policy",
      outcome: "rejected",
      subjectId: req.subjectId,
      deviceId: req.deviceId,
      action: "locality_proof",
      failureClass: "federated.locality_forbidden",
      operationId: req.operationId,
    });
    return {
      ok: false,
      failureClass: "federated.locality_forbidden",
      detail: "federated upload may not egress to third-party destinations",
    };
  }

  // On-device: zero third-party egress; destination must stay on-device or self-hosted allowlist.
  if (req.locality === "on-device") {
    if (
      proof.egressObserved &&
      proof.destinationClass !== "self-hosted" &&
      proof.destinationClass !== "on-device"
    ) {
      return {
        ok: false,
        failureClass: "federated.locality_egress",
        detail: "on-device federated upload observed forbidden egress",
      };
    }
    if (
      proof.destinationClass === "self-hosted" &&
      proof.destinationHostClass !== "self-hosted-allowlist"
    ) {
      return {
        ok: false,
        failureClass: "federated.locality_forbidden",
        detail: "on-device→self-hosted upload requires allowlisted destination",
      };
    }
  }

  // Self-hosted: uploads stay on self-hosted allowlist; unexpected egress class fails.
  if (req.locality === "self-hosted") {
    if (proof.destinationClass !== "self-hosted") {
      return {
        ok: false,
        failureClass: "federated.locality_forbidden",
        detail: "self-hosted federated upload destination must be self-hosted",
      };
    }
    if (proof.destinationHostClass !== "self-hosted-allowlist") {
      return {
        ok: false,
        failureClass: "federated.locality_forbidden",
        detail: "self-hosted upload requires allowlisted aggregator host class",
      };
    }
  }

  emit(input.onTelemetry, {
    event: "learning.federated.policy",
    outcome: "ok",
    subjectId: req.subjectId,
    deviceId: req.deviceId,
    action: "locality_proof",
    operationId: req.operationId,
  });
  return { ok: true, proof };
}

async function withUploadTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  meta: { subjectId: string; deviceId: string; operationId: string },
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guarded = Promise.resolve()
    .then(() => promise)
    .then(
      (value) => ({ kind: "ok" as const, value }),
      (error: unknown) => ({ kind: "err" as const, error }),
    );
  try {
    const raced = await Promise.race([
      guarded,
      new Promise<{ kind: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
      }),
    ]);
    if (raced.kind === "timeout") {
      throw new FederatedPolicyError(
        `federated upload gate timed out after ${timeoutMs}ms`,
        {
          obligation: "federated.downstream_timeout",
          subjectId: meta.subjectId,
          deviceId: meta.deviceId,
        },
      );
    }
    if (raced.kind === "err") {
      if (raced.error instanceof FederatedPolicyError) throw raced.error;
      throw new FederatedPolicyError(
        `federated upload gate failed: ${
          raced.error instanceof Error ? raced.error.message : "unknown"
        }`,
        {
          obligation: "federated.partial_failure",
          subjectId: meta.subjectId,
          deviceId: meta.deviceId,
        },
      );
    }
    return raced.value;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Federated upload gate: eligibility + anonymization + B9 locality proof.
 * Missing locality proof or raw subject content → typed reject (default deny).
 */
export async function runFederatedUploadGate(input: {
  request: FederatedAggregationRequest;
  localityProof?: FederatedLocalityProof | null;
  ledger?: SubjectConsentLedger;
  timeoutMs?: number;
  now?: () => string;
  onTelemetry?: (e: FederatedPolicyTelemetryEvent) => void;
}): Promise<FederatedUploadGateResult> {
  const req = input.request;
  const uploadedAt = (input.now ?? (() => new Date().toISOString()))();
  const timeoutMs = input.timeoutMs ?? FEDERATED_UPLOAD_DEFAULT_TIMEOUT_MS;
  const receiptKey = `${req.operationId}|${req.subjectId}|${req.deviceId}`;

  const prior = uploadReceipts.get(receiptKey);
  if (prior !== undefined) {
    emit(input.onTelemetry, {
      event: "learning.federated.policy",
      outcome: "idempotent_replay",
      subjectId: req.subjectId,
      deviceId: req.deviceId,
      action: "upload_gate",
      operationId: req.operationId,
    });
    if (prior.ok) {
      return { ...prior, idempotentReplay: true };
    }
    return prior;
  }

  if (uploadSubjectLocks.has(req.subjectId)) {
    const rejected: FederatedUploadRejected = {
      ok: false,
      schemaVersion: FEDERATED_UPLOAD_GATE_SCHEMA_VERSION,
      operationId: req.operationId,
      subjectId: req.subjectId,
      deviceId: req.deviceId,
      failureClass: "federated.idempotent_conflict",
      detail: "concurrent federated upload for the same subjectId is forbidden",
    };
    emit(input.onTelemetry, {
      event: "learning.federated.policy",
      outcome: "rejected",
      subjectId: req.subjectId,
      deviceId: req.deviceId,
      action: "upload_gate",
      failureClass: "federated.idempotent_conflict",
      operationId: req.operationId,
    });
    return rejected;
  }

  if (uploadReceipts.size >= FEDERATED_UPLOAD_RECEIPT_LIMIT) {
    return {
      ok: false,
      schemaVersion: FEDERATED_UPLOAD_GATE_SCHEMA_VERSION,
      operationId: req.operationId,
      subjectId: req.subjectId,
      deviceId: req.deviceId,
      failureClass: "federated.capacity",
      detail: "federated upload receipt capacity exceeded",
    };
  }

  uploadSubjectLocks.add(req.subjectId);
  let durableStarted = false;
  try {
    return await withUploadTimeout(
      Promise.resolve().then(() => {
        emit(input.onTelemetry, {
          event: "learning.federated.policy",
          outcome: "ok",
          subjectId: req.subjectId,
          deviceId: req.deviceId,
          action: "upload_gate",
          operationId: req.operationId,
        });

        const locality = assertFederatedUploadLocalityProof({
          request: req,
          localityProof: input.localityProof,
          ...(input.onTelemetry !== undefined
            ? { onTelemetry: input.onTelemetry }
            : {}),
        });
        if (!locality.ok) {
          const rejected: FederatedUploadRejected = {
            ok: false,
            schemaVersion: FEDERATED_UPLOAD_GATE_SCHEMA_VERSION,
            operationId: req.operationId,
            subjectId: req.subjectId,
            deviceId: req.deviceId,
            failureClass: locality.failureClass,
            detail: locality.detail,
          };
          uploadReceipts.set(receiptKey, rejected);
          return rejected;
        }

        durableStarted = true;
        const eligibility = evaluateFederatedAggregationEligibility({
          request: req,
          ...(input.ledger !== undefined ? { ledger: input.ledger } : {}),
          ...(input.onTelemetry !== undefined
            ? { onTelemetry: input.onTelemetry }
            : {}),
        });
        if (!eligibility.ok) {
          const rejected: FederatedUploadRejected = {
            ok: false,
            schemaVersion: FEDERATED_UPLOAD_GATE_SCHEMA_VERSION,
            operationId: req.operationId,
            subjectId: eligibility.subjectId,
            deviceId: req.deviceId,
            failureClass: eligibility.failureClass,
            detail: eligibility.detail,
          };
          uploadReceipts.set(receiptKey, rejected);
          return rejected;
        }

        const accepted: FederatedUploadAccepted = {
          ok: true,
          schemaVersion: FEDERATED_UPLOAD_GATE_SCHEMA_VERSION,
          operationId: req.operationId,
          subjectId: eligibility.subjectId,
          deviceId: req.deviceId,
          locality: req.locality,
          federationTier: eligibility.federationTier,
          participantToken: eligibility.participantToken,
          dp: eligibility.dp,
          bundleFingerprint: fingerprintBundle(req.bundle),
          localityProof: locality.proof,
          uploadedAt,
          idempotentReplay: false,
        };
        uploadReceipts.set(receiptKey, accepted);
        emit(input.onTelemetry, {
          event: "learning.federated.policy",
          outcome: "ok",
          subjectId: req.subjectId,
          deviceId: req.deviceId,
          action: "upload_gate",
          federationTier: eligibility.federationTier,
          operationId: req.operationId,
        });
        return accepted;
      }),
      timeoutMs,
      {
        subjectId: req.subjectId,
        deviceId: req.deviceId,
        operationId: req.operationId,
      },
    );
  } catch (error) {
    if (durableStarted && !(error instanceof FederatedPolicyError)) {
      throw new FederatedPolicyError(
        `partial federated upload failure: ${
          error instanceof Error ? error.message : "unknown"
        }`,
        {
          obligation: "federated.partial_failure",
          subjectId: req.subjectId,
          deviceId: req.deviceId,
        },
      );
    }
    throw error;
  } finally {
    uploadSubjectLocks.delete(req.subjectId);
  }
}

export type FederatedUploadGateProof = {
  ok: true;
  accepted: boolean;
  missingProofDenied: boolean;
  rawContentDenied: boolean;
  thirdPartyDenied: boolean;
  defaultDenyMissingTier: boolean;
  subjectIsolated: boolean;
  idempotentReplay: boolean;
};

/**
 * Micro-run: known-good metadata upload admits; missing proof / raw / third-party deny.
 */
export async function proveFederatedUploadGate(input: {
  deviceId?: string;
  onTelemetry?: (e: FederatedPolicyTelemetryEvent) => void;
}): Promise<FederatedUploadGateProof> {
  resetFederatedPolicyReceipts();
  const deviceId = input.deviceId ?? "device.federated.upload";
  const baseRequest: FederatedAggregationRequest = {
    operationId: "op.fed.upload.ok",
    subjectId: "tenant.aurora.learner-upload",
    deviceId,
    locality: "self-hosted",
    federationTier: "research_anon",
    consentClass: "research",
    optedIn: true,
    anonymized: true,
    dp: FEDERATION_DP_PARAMS.research_anon,
    bundle: { featureHash: "sha256:upload", count: 3 },
  };
  const goodProof: FederatedLocalityProof = {
    schemaVersion: FEDERATED_LOCALITY_PROOF_SCHEMA_VERSION,
    subjectId: baseRequest.subjectId,
    deviceId,
    locality: "self-hosted",
    destinationClass: "self-hosted",
    payloadClass: "metadata",
    egressObserved: true,
    destinationHostClass: "self-hosted-allowlist",
    completedAt: "2026-07-17T15:00:00.000Z",
  };

  const accepted = await runFederatedUploadGate({
    request: baseRequest,
    localityProof: goodProof,
    now: () => "2026-07-17T15:00:01.000Z",
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });
  const replay = await runFederatedUploadGate({
    request: baseRequest,
    localityProof: goodProof,
    now: () => "2026-07-17T15:00:02.000Z",
  });

  const missing = await runFederatedUploadGate({
    request: {
      ...baseRequest,
      operationId: "op.fed.upload.missing-proof",
    },
    localityProof: null,
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });

  const raw = await runFederatedUploadGate({
    request: {
      ...baseRequest,
      operationId: "op.fed.upload.raw",
      bundle: { utterance: "raw subject content" },
    },
    localityProof: {
      ...goodProof,
      subjectId: baseRequest.subjectId,
    },
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });

  const thirdParty = await runFederatedUploadGate({
    request: {
      ...baseRequest,
      operationId: "op.fed.upload.third-party",
    },
    localityProof: {
      ...goodProof,
      destinationClass: "third-party",
      destinationHostClass: "third-party",
    },
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });

  const noTier = await runFederatedUploadGate({
    request: {
      ...baseRequest,
      operationId: "op.fed.upload.no-tier",
      federationTier: null,
    },
    localityProof: goodProof,
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });

  const otherSubjectProof: FederatedLocalityProof = {
    ...goodProof,
    subjectId: "tenant.other.learner",
  };
  const cross = await runFederatedUploadGate({
    request: {
      ...baseRequest,
      operationId: "op.fed.upload.cross",
    },
    localityProof: otherSubjectProof,
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });

  return {
    ok: true,
    accepted: accepted.ok === true,
    missingProofDenied:
      !missing.ok && missing.failureClass === "federated.locality_proof_missing",
    rawContentDenied:
      !raw.ok && raw.failureClass === "federated.sovereignty",
    thirdPartyDenied:
      !thirdParty.ok &&
      thirdParty.failureClass === "federated.locality_forbidden",
    defaultDenyMissingTier:
      !noTier.ok && noTier.failureClass === "federated.default_deny",
    subjectIsolated:
      !cross.ok && cross.failureClass === "federated.cross_subject",
    idempotentReplay: replay.ok === true && replay.idempotentReplay === true,
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * Default-deny negative fixture suite (C7 continuous cadence)
 * ──────────────────────────────────────────────────────────────────────── */

export const FEDERATED_DEFAULT_DENY_FIXTURES_RELPATH =
  "training/federated/fixtures" as const;
export const FEDERATED_DEFAULT_DENY_SUITE_FIXTURE =
  "default-deny-negative-suite.json" as const;
export const FEDERATED_DEFAULT_DENY_SUITE_SCHEMA_VERSION =
  "federated.default-deny-suite.v1" as const;
export const FEDERATED_DEFAULT_DENY_FIXTURE_BYTES_LIMIT = 65_536 as const;
export const FEDERATED_DEFAULT_DENY_CASE_LIMIT = 32 as const;

export type FederatedDefaultDenyFixtureCase = {
  caseId: string;
  expect: "accept" | "reject";
  expectedFailureClass: FederatedPolicyFailureClass | null;
  request: {
    operationId: string;
    subjectId: string;
    federationTier?: string | null;
    consentClass?: string | null;
    optedIn?: boolean;
    anonymized?: boolean;
    dp?: Partial<FederatedDpParams> | null;
    bundle?: Record<string, unknown>;
  };
  localityProof: {
    destinationClass: FederatedUploadDestinationClass;
    payloadClass: FederatedUploadPayloadClass;
    egressObserved: boolean;
    destinationHostClass: "self-hosted-allowlist" | "third-party" | "none";
  } | null;
};

export type FederatedDefaultDenySuiteDocument = {
  schemaVersion: typeof FEDERATED_DEFAULT_DENY_SUITE_SCHEMA_VERSION;
  suiteId: string;
  deviceId: string;
  locality: "on-device" | "self-hosted";
  cases: FederatedDefaultDenyFixtureCase[];
};

export type FederatedDefaultDenyNegativeProof = {
  ok: true;
  suiteId: string;
  caseCount: number;
  missingConsentBlocked: boolean;
  rawContentBlocked: boolean;
  wrongAnonymizationBlocked: boolean;
  consentTierMismatchBlocked: boolean;
  missingLocalityProofBlocked: boolean;
  provenAccepted: boolean;
  onlyProvenAccepted: boolean;
  subjectIsolated: boolean;
};

function isFederatedFailureClass(
  value: unknown,
): value is FederatedPolicyFailureClass {
  return (
    typeof value === "string" &&
    value.startsWith("federated.") &&
    value.length <= 64
  );
}

/**
 * Load the committed default-deny negative suite (metadata-only fixtures).
 */
export async function loadFederatedDefaultDenySuite(input: {
  repoRoot: string;
  deviceId?: string;
  onTelemetry?: (e: FederatedPolicyTelemetryEvent) => void;
}): Promise<
  | { ok: true; document: FederatedDefaultDenySuiteDocument }
  | { ok: false; failureClass: FederatedPolicyFailureClass; detail: string }
> {
  const fixturePath = path.join(
    input.repoRoot,
    FEDERATED_DEFAULT_DENY_FIXTURES_RELPATH,
    FEDERATED_DEFAULT_DENY_SUITE_FIXTURE,
  );
  let text: string;
  try {
    text = await readFile(fixturePath, "utf8");
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : "failed to read fixture suite";
    emit(input.onTelemetry, {
      event: "learning.federated.policy",
      outcome: "rejected",
      subjectId: null,
      ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      action: "worked_example",
      failureClass: "federated.policy_gap",
      exampleId: "default_deny_suite_missing",
    });
    return { ok: false, failureClass: "federated.policy_gap", detail };
  }
  if (text.length > FEDERATED_DEFAULT_DENY_FIXTURE_BYTES_LIMIT) {
    return {
      ok: false,
      failureClass: "federated.section_limit",
      detail: `fixture exceeds ${FEDERATED_DEFAULT_DENY_FIXTURE_BYTES_LIMIT} bytes`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return {
      ok: false,
      failureClass: "federated.invalid_input",
      detail: "default-deny suite fixture is not valid JSON",
    };
  }
  if (parsed === null || typeof parsed !== "object") {
    return {
      ok: false,
      failureClass: "federated.invalid_input",
      detail: "default-deny suite fixture must be an object",
    };
  }
  const doc = parsed as Record<string, unknown>;
  if (doc.schemaVersion !== FEDERATED_DEFAULT_DENY_SUITE_SCHEMA_VERSION) {
    return {
      ok: false,
      failureClass: "federated.invalid_input",
      detail: "default-deny suite schemaVersion mismatch",
    };
  }
  if (!Array.isArray(doc.cases) || doc.cases.length < 1) {
    return {
      ok: false,
      failureClass: "federated.section_limit",
      detail: "default-deny suite requires at least one case",
    };
  }
  if (doc.cases.length > FEDERATED_DEFAULT_DENY_CASE_LIMIT) {
    return {
      ok: false,
      failureClass: "federated.section_limit",
      detail: `default-deny suite exceeds ${FEDERATED_DEFAULT_DENY_CASE_LIMIT} cases`,
    };
  }
  if (
    typeof doc.suiteId !== "string" ||
    typeof doc.deviceId !== "string" ||
    (doc.locality !== "on-device" && doc.locality !== "self-hosted")
  ) {
    return {
      ok: false,
      failureClass: "federated.invalid_input",
      detail: "default-deny suite header fields invalid",
    };
  }

  const cases: FederatedDefaultDenyFixtureCase[] = [];
  for (const rawCase of doc.cases) {
    if (rawCase === null || typeof rawCase !== "object") {
      return {
        ok: false,
        failureClass: "federated.invalid_input",
        detail: "suite case must be an object",
      };
    }
    const c = rawCase as Record<string, unknown>;
    if (
      typeof c.caseId !== "string" ||
      (c.expect !== "accept" && c.expect !== "reject") ||
      c.request === null ||
      typeof c.request !== "object"
    ) {
      return {
        ok: false,
        failureClass: "federated.invalid_input",
        detail: `invalid case shape: ${String(c.caseId)}`,
      };
    }
    if (
      c.expect === "reject" &&
      !isFederatedFailureClass(c.expectedFailureClass)
    ) {
      return {
        ok: false,
        failureClass: "federated.invalid_input",
        detail: `reject case ${c.caseId} needs expectedFailureClass`,
      };
    }
    cases.push({
      caseId: c.caseId,
      expect: c.expect,
      expectedFailureClass:
        c.expectedFailureClass === null
          ? null
          : (c.expectedFailureClass as FederatedPolicyFailureClass),
      request: c.request as FederatedDefaultDenyFixtureCase["request"],
      localityProof:
        c.localityProof === null
          ? null
          : (c.localityProof as FederatedDefaultDenyFixtureCase["localityProof"]),
    });
  }

  emit(input.onTelemetry, {
    event: "learning.federated.policy",
    outcome: "ok",
    subjectId: null,
    ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
    action: "worked_example",
    exampleId: "default_deny_suite_loaded",
  });

  return {
    ok: true,
    document: {
      schemaVersion: FEDERATED_DEFAULT_DENY_SUITE_SCHEMA_VERSION,
      suiteId: doc.suiteId,
      deviceId: doc.deviceId,
      locality: doc.locality,
      cases,
    },
  };
}

/**
 * Fixture-driven negative suite: missing consent, raw leak, wrong anonymization
 * tier, and related denies — only the fully proven bundle may accept.
 */
export async function proveFederatedDefaultDenyNegativeSuite(input: {
  repoRoot: string;
  deviceId?: string;
  onTelemetry?: (e: FederatedPolicyTelemetryEvent) => void;
}): Promise<FederatedDefaultDenyNegativeProof> {
  resetFederatedPolicyReceipts();
  const loaded = await loadFederatedDefaultDenySuite({
    repoRoot: input.repoRoot,
    ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });
  if (!loaded.ok) {
    throw new FederatedPolicyError(loaded.detail, {
      obligation: loaded.failureClass,
      ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
    });
  }

  const doc = loaded.document;
  const deviceId = input.deviceId ?? doc.deviceId;
  const results = new Map<string, FederatedUploadGateResult>();
  let acceptCount = 0;

  for (const fixtureCase of doc.cases) {
    const req = fixtureCase.request;
    const request: FederatedAggregationRequest = {
      operationId: req.operationId,
      subjectId: req.subjectId,
      deviceId,
      locality: doc.locality,
      ...(req.federationTier !== undefined
        ? { federationTier: req.federationTier }
        : {}),
      ...(req.consentClass !== undefined
        ? { consentClass: req.consentClass }
        : {}),
      ...(req.optedIn !== undefined ? { optedIn: req.optedIn } : {}),
      ...(req.anonymized !== undefined ? { anonymized: req.anonymized } : {}),
      ...(req.dp !== undefined ? { dp: req.dp } : {}),
      ...(req.bundle !== undefined ? { bundle: req.bundle } : {}),
    };

    let localityProof: FederatedLocalityProof | null = null;
    if (fixtureCase.localityProof !== null) {
      localityProof = {
        schemaVersion: FEDERATED_LOCALITY_PROOF_SCHEMA_VERSION,
        subjectId: req.subjectId,
        deviceId,
        locality: doc.locality,
        destinationClass: fixtureCase.localityProof.destinationClass,
        payloadClass: fixtureCase.localityProof.payloadClass,
        egressObserved: fixtureCase.localityProof.egressObserved,
        destinationHostClass: fixtureCase.localityProof.destinationHostClass,
        completedAt: "2026-07-17T16:00:00.000Z",
      };
    }

    const outcome = await runFederatedUploadGate({
      request,
      localityProof,
      now: () => "2026-07-17T16:00:01.000Z",
      ...(input.onTelemetry !== undefined
        ? { onTelemetry: input.onTelemetry }
        : {}),
    });
    results.set(fixtureCase.caseId, outcome);

    if (fixtureCase.expect === "accept") {
      if (!outcome.ok) {
        throw new FederatedPolicyError(
          `proven fixture ${fixtureCase.caseId} must accept`,
          {
            obligation: "federated.policy_gap",
            subjectId: req.subjectId,
            deviceId,
          },
        );
      }
      acceptCount += 1;
    } else {
      if (
        outcome.ok ||
        outcome.failureClass !== fixtureCase.expectedFailureClass
      ) {
        throw new FederatedPolicyError(
          `negative fixture ${fixtureCase.caseId} expected ${fixtureCase.expectedFailureClass}, got ${
            outcome.ok ? "accept" : outcome.failureClass
          }`,
          {
            obligation: "federated.policy_gap",
            subjectId: req.subjectId,
            deviceId,
          },
        );
      }
    }

    emit(input.onTelemetry, {
      event: "learning.federated.policy",
      outcome: outcome.ok ? "ok" : "rejected",
      subjectId: req.subjectId,
      deviceId,
      action: "worked_example",
      exampleId: fixtureCase.caseId,
      ...(outcome.ok
        ? { federationTier: outcome.federationTier }
        : { failureClass: outcome.failureClass }),
      operationId: req.operationId,
    });
  }

  // Sovereignty: a foreign subject cannot read another fixture's admit.
  const proven = results.get("proven-accept");
  let subjectIsolated = false;
  if (proven?.ok === true) {
    try {
      // Cross-subject locality proof against the proven subject must fail.
      const cross = await runFederatedUploadGate({
        request: {
          operationId: "op.fed.neg.cross-read",
          subjectId: "tenant.neg.proven",
          deviceId,
          locality: doc.locality,
          federationTier: "research_anon",
          consentClass: "research",
          optedIn: true,
          anonymized: true,
          dp: FEDERATION_DP_PARAMS.research_anon,
          bundle: { featureHash: "sha256:cross" },
        },
        localityProof: {
          schemaVersion: FEDERATED_LOCALITY_PROOF_SCHEMA_VERSION,
          subjectId: "tenant.neg.attacker",
          deviceId,
          locality: doc.locality,
          destinationClass: "self-hosted",
          payloadClass: "metadata",
          egressObserved: true,
          destinationHostClass: "self-hosted-allowlist",
          completedAt: "2026-07-17T16:00:02.000Z",
        },
      });
      subjectIsolated =
        !cross.ok && cross.failureClass === "federated.cross_subject";
    } catch {
      subjectIsolated = false;
    }
  }

  const missingConsent = results.get("missing-consent");
  const rawLeak = results.get("raw-content-leak");
  const wrongAnon = results.get("wrong-anonymization-tier");
  const tierMismatch = results.get("consent-tier-mismatch");
  const missingProof = results.get("missing-locality-proof");

  const proof: FederatedDefaultDenyNegativeProof = {
    ok: true,
    suiteId: doc.suiteId,
    caseCount: doc.cases.length,
    missingConsentBlocked:
      missingConsent !== undefined &&
      !missingConsent.ok &&
      missingConsent.failureClass === "federated.default_deny",
    rawContentBlocked:
      rawLeak !== undefined &&
      !rawLeak.ok &&
      rawLeak.failureClass === "federated.sovereignty",
    wrongAnonymizationBlocked:
      wrongAnon !== undefined &&
      !wrongAnon.ok &&
      wrongAnon.failureClass === "federated.anonymization_missing",
    consentTierMismatchBlocked:
      tierMismatch !== undefined &&
      !tierMismatch.ok &&
      tierMismatch.failureClass === "federated.consent_mismatch",
    missingLocalityProofBlocked:
      missingProof !== undefined &&
      !missingProof.ok &&
      missingProof.failureClass === "federated.locality_proof_missing",
    provenAccepted: proven?.ok === true,
    onlyProvenAccepted: acceptCount === 1 && proven?.ok === true,
    subjectIsolated,
  };

  if (
    !proof.missingConsentBlocked ||
    !proof.rawContentBlocked ||
    !proof.wrongAnonymizationBlocked ||
    !proof.onlyProvenAccepted ||
    !proof.subjectIsolated
  ) {
    throw new FederatedPolicyError(
      "federated default-deny negative suite failed to prove",
      { obligation: "federated.policy_gap", deviceId },
    );
  }

  return proof;
}
