/**
 * Consent-law gate — B9-aligned consent classes over every learning data path.
 *
 * Invariants:
 * - No trajectory enters export / training without a recorded consent class.
 * - Cross-subject / federated aggregation is default-deny without anonymization
 *   plus a training-eligible consent tier.
 * - Revocation excludes future corpus/export builds; it does not delete prior
 *   trained checkpoints (separate remediation).
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  CONSENT_CLASSES,
  type TrajectoryConsent,
  type TrajectoryConsentClass,
} from "./trajectory_schema.js";

/** Soft caps (NFR — bounded subject ledgers / class sets / shard batches). */
export const CONSENT_CLASS_LIMIT = 8;
export const CONSENT_SUBJECT_LEDGER_LIMIT = 4096;
export const CORPUS_SHARD_BATCH_LIMIT = 512;
export const CORPUS_SHARD_ID_LIMIT = 128;
export const CORPUS_SHARD_HASH_LIMIT = 128;
export const CONSENT_FIXTURE_BYTES_LIMIT = 65_536;

/** Repo-relative consent-law fixture tree (integration / negative suite). */
export const CONSENT_GATE_FIXTURES_RELPATH =
  "packages/learning/fixtures/consent" as const;
export const CONSENT_ACCEPTED_SHARDS_FIXTURE =
  "accepted-shards.json" as const;
export const CONSENT_NEGATIVE_OPT_OUT_FIXTURE =
  "negative-opt-out-trajectory.json" as const;
export const CONSENT_NEGATIVE_FEDERATED_FIXTURE =
  "negative-federated-shard.json" as const;
export const CONSENT_GATE_FIXTURE_SCHEMA_VERSION =
  "consent-gate.v1" as const;

/**
 * B9 consent class enum (wire-aligned with TurnTrajectoryRecord.consent).
 * Canonical values: research | product-improve | personal.
 */
export const CONSENT_CLASS_ENUM = Object.freeze([
  "research",
  "product-improve",
  "personal",
] as const);

export type ConsentClass = (typeof CONSENT_CLASS_ENUM)[number];

/**
 * Classes that may cover teacher distillation via third-party frontier APIs
 * when the export path declares third-party processing. `personal` never does.
 */
export const THIRD_PARTY_ELIGIBLE_CONSENT_CLASSES = Object.freeze([
  "research",
  "product-improve",
] as const);

export type ThirdPartyEligibleConsentClass =
  (typeof THIRD_PARTY_ELIGIBLE_CONSENT_CLASSES)[number];

export type ConsentGateFailureClass =
  | "missing_consent"
  | "consent_denied"
  | "unknown_consent_class"
  | "third_party_excluded"
  | "consent_revoked"
  | "cross_subject"
  | "missing_subject"
  | "ledger_limit"
  | "shard_excluded"
  | "batch_limit";

/**
 * Corpus-factory shard consent classes (distinct from B9 trajectory classes).
 * Unknown class → exclude. Missing class → exclude.
 */
export const CORPUS_SHARD_CONSENT_CLASSES = Object.freeze([
  "consented",
  "public",
  "synthetic",
  "government",
] as const);

export type CorpusShardConsentClass =
  (typeof CORPUS_SHARD_CONSENT_CLASSES)[number];

/**
 * Shard classes that may cover third-party frontier teacher distillation.
 * `government` never leaves a sovereign / licensed path for third-party APIs.
 */
export const THIRD_PARTY_ELIGIBLE_SHARD_CLASSES = Object.freeze([
  "consented",
  "public",
  "synthetic",
] as const);

export type ConsentGateTelemetryEvent = {
  event: "learning.consent";
  action: "evaluate" | "revoke" | "align_b9" | "shard_include";
  outcome: "ok" | "rejected";
  subjectId: string | null;
  deviceId?: string;
  failureClass?: ConsentGateFailureClass;
  consentClass?: ConsentClass;
  shardConsentClass?: CorpusShardConsentClass;
  shardId?: string;
};

export type ConsentGateOptions = {
  subjectId?: string | null;
  deviceId?: string;
  onTelemetry?: (event: ConsentGateTelemetryEvent) => void;
};

/** Prove consent-law enum matches B9 trajectory wire classes. */
export function assertConsentClassEnumAlignedWithB9(
  options: ConsentGateOptions = {},
):
  | { ok: true }
  | { ok: false; failureClass: "unknown_consent_class"; detail: string } {
  const left = [...CONSENT_CLASS_ENUM].sort().join("|");
  const right = [...CONSENT_CLASSES].sort().join("|");
  if (left !== right || CONSENT_CLASS_ENUM.length > CONSENT_CLASS_LIMIT) {
    options.onTelemetry?.({
      event: "learning.consent",
      action: "align_b9",
      outcome: "rejected",
      subjectId: options.subjectId ?? null,
      ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
      failureClass: "unknown_consent_class",
    });
    return {
      ok: false,
      failureClass: "unknown_consent_class",
      detail: `consent enum drift vs B9: law=${left} b9=${right}`,
    };
  }
  options.onTelemetry?.({
    event: "learning.consent",
    action: "align_b9",
    outcome: "ok",
    subjectId: options.subjectId ?? null,
    ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
  });
  return { ok: true };
}

export function isConsentClass(value: unknown): value is ConsentClass {
  return (
    typeof value === "string" &&
    (CONSENT_CLASS_ENUM as readonly string[]).includes(value)
  );
}

export function parseConsentClass(
  value: unknown,
  options: ConsentGateOptions = {},
):
  | { ok: true; consentClass: ConsentClass }
  | {
      ok: false;
      failureClass: "unknown_consent_class";
      detail: string;
    } {
  if (!isConsentClass(value)) {
    options.onTelemetry?.({
      event: "learning.consent",
      action: "evaluate",
      outcome: "rejected",
      subjectId: options.subjectId ?? null,
      ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
      failureClass: "unknown_consent_class",
    });
    return {
      ok: false,
      failureClass: "unknown_consent_class",
      detail: "consentClass must be research|product-improve|personal",
    };
  }
  return { ok: true, consentClass: value };
}

export function allowsThirdPartyProcessing(
  consentClass: ConsentClass,
): boolean {
  return (THIRD_PARTY_ELIGIBLE_CONSENT_CLASSES as readonly string[]).includes(
    consentClass,
  );
}

/**
 * Subject-scoped revocation ledger. Revoke excludes future export/corpus
 * inclusion; it never deletes already-trained checkpoints.
 */
export class SubjectConsentLedger {
  private readonly revoked = new Set<string>();

  size(): number {
    return this.revoked.size;
  }

  isRevoked(subjectId: string): boolean {
    return this.revoked.has(subjectId);
  }

  /**
   * Mark subject opted out of future learning paths. Idempotent for replays.
   */
  revoke(
    subjectId: string,
    options: ConsentGateOptions = {},
  ):
    | { ok: true; subjectId: string; idempotent: boolean }
    | {
        ok: false;
        failureClass: "missing_subject" | "ledger_limit";
        subjectId: string | null;
        detail: string;
      } {
    if (!subjectId) {
      options.onTelemetry?.({
        event: "learning.consent",
        action: "revoke",
        outcome: "rejected",
        subjectId: null,
        ...(options.deviceId !== undefined
          ? { deviceId: options.deviceId }
          : {}),
        failureClass: "missing_subject",
      });
      return {
        ok: false,
        failureClass: "missing_subject",
        subjectId: null,
        detail: "subjectId required to revoke consent",
      };
    }
    if (
      !this.revoked.has(subjectId) &&
      this.revoked.size >= CONSENT_SUBJECT_LEDGER_LIMIT
    ) {
      options.onTelemetry?.({
        event: "learning.consent",
        action: "revoke",
        outcome: "rejected",
        subjectId,
        ...(options.deviceId !== undefined
          ? { deviceId: options.deviceId }
          : {}),
        failureClass: "ledger_limit",
      });
      return {
        ok: false,
        failureClass: "ledger_limit",
        subjectId,
        detail: `revocation ledger exceeds ${CONSENT_SUBJECT_LEDGER_LIMIT}`,
      };
    }
    const idempotent = this.revoked.has(subjectId);
    this.revoked.add(subjectId);
    options.onTelemetry?.({
      event: "learning.consent",
      action: "revoke",
      outcome: "ok",
      subjectId,
      ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
    });
    return { ok: true, subjectId, idempotent };
  }
}

export type TrajectoryConsentGateInput = {
  subjectId: string;
  /** Absent / null → missing_consent (hard reject). */
  consent: TrajectoryConsent | ConsentRecordLike | null | undefined;
  deviceId?: string;
  /** Teacher distillation path touching third-party frontier APIs. */
  requiresThirdPartyProcessing?: boolean;
  /** Federated / multi-subject aggregation attempt. */
  crossSubject?: boolean;
  /** Required with crossSubject — default deny without it. */
  anonymized?: boolean;
  /** Optional ledger — when subject is revoked, future export is excluded. */
  ledger?: SubjectConsentLedger;
};

type ConsentRecordLike = {
  optedIn: boolean;
  consentClass: string;
  recordedAt: string;
};

export type TrajectoryConsentGateAccepted = {
  ok: true;
  subjectId: string;
  consentClass: ConsentClass;
};

export type TrajectoryConsentGateRejected = {
  ok: false;
  failureClass: ConsentGateFailureClass;
  subjectId: string | null;
  detail: string;
};

export type TrajectoryConsentGateResult =
  | TrajectoryConsentGateAccepted
  | TrajectoryConsentGateRejected;

/**
 * Evaluate consent for a trajectory leaving the sovereign store toward
 * training / export. Distinct failure classes — never silent pass-through.
 */
export function evaluateTrajectoryConsent(
  input: TrajectoryConsentGateInput,
  options: ConsentGateOptions = {},
): TrajectoryConsentGateResult {
  const subjectId = input.subjectId;
  const deviceId = input.deviceId ?? options.deviceId;
  const emit = (
    outcome: "ok" | "rejected",
    failureClass?: ConsentGateFailureClass,
    consentClass?: ConsentClass,
  ): void => {
    options.onTelemetry?.({
      event: "learning.consent",
      action: "evaluate",
      outcome,
      subjectId: subjectId || null,
      ...(deviceId !== undefined ? { deviceId } : {}),
      ...(failureClass !== undefined ? { failureClass } : {}),
      ...(consentClass !== undefined ? { consentClass } : {}),
    });
  };

  if (!subjectId) {
    emit("rejected", "missing_subject");
    return {
      ok: false,
      failureClass: "missing_subject",
      subjectId: null,
      detail: "subjectId required",
    };
  }

  if (input.ledger?.isRevoked(subjectId)) {
    emit("rejected", "consent_revoked");
    return {
      ok: false,
      failureClass: "consent_revoked",
      subjectId,
      detail: "subject revoked future training consent",
    };
  }

  if (input.crossSubject === true) {
    const consentObj = input.consent;
    const classOk =
      consentObj &&
      typeof consentObj === "object" &&
      isConsentClass(consentObj.consentClass) &&
      consentObj.optedIn === true;
    if (input.anonymized !== true || !classOk) {
      emit("rejected", "cross_subject");
      return {
        ok: false,
        failureClass: "cross_subject",
        subjectId,
        detail:
          "cross-subject aggregation requires anonymization + opted-in consent class",
      };
    }
  }

  if (input.consent == null || typeof input.consent !== "object") {
    emit("rejected", "missing_consent");
    return {
      ok: false,
      failureClass: "missing_consent",
      subjectId,
      detail: "trajectory export requires a recorded consent object",
    };
  }

  const parsedClass = parseConsentClass(input.consent.consentClass, {
    subjectId,
    ...(deviceId !== undefined ? { deviceId } : {}),
  });
  if (!parsedClass.ok) {
    emit("rejected", "unknown_consent_class");
    return {
      ok: false,
      failureClass: "unknown_consent_class",
      subjectId,
      detail: parsedClass.detail,
    };
  }

  if (input.consent.optedIn !== true) {
    emit("rejected", "consent_denied", parsedClass.consentClass);
    return {
      ok: false,
      failureClass: "consent_denied",
      subjectId,
      detail: "export requires consent.optedIn === true",
    };
  }

  if (
    input.requiresThirdPartyProcessing === true &&
    !allowsThirdPartyProcessing(parsedClass.consentClass)
  ) {
    emit("rejected", "third_party_excluded", parsedClass.consentClass);
    return {
      ok: false,
      failureClass: "third_party_excluded",
      subjectId,
      detail:
        "third-party teacher distillation requires research|product-improve consent",
    };
  }

  emit("ok", undefined, parsedClass.consentClass);
  return {
    ok: true,
    subjectId,
    consentClass: parsedClass.consentClass,
  };
}

/** Opaque corpus shard candidate — metadata only; never learner utterance bodies. */
export type CorpusShardCandidate = {
  shardId: string;
  /** Opaque content hash (e.g. sha256:…) — never raw content. */
  contentHash: string;
  /** Missing / unknown → exclude from training. */
  consentClass?: string | null;
  /**
   * Required when consentClass is `consented`.
   * Public / synthetic / government shards may omit a subject.
   */
  subjectId?: string | null;
  deviceId?: string;
  locality?: "on-device" | "self-hosted";
  requiresThirdPartyProcessing?: boolean;
  crossSubject?: boolean;
  anonymized?: boolean;
};

export function isCorpusShardConsentClass(
  value: unknown,
): value is CorpusShardConsentClass {
  return (
    typeof value === "string" &&
    (CORPUS_SHARD_CONSENT_CLASSES as readonly string[]).includes(value)
  );
}

export function parseCorpusShardConsentClass(
  value: unknown,
  options: ConsentGateOptions = {},
):
  | { ok: true; consentClass: CorpusShardConsentClass }
  | {
      ok: false;
      failureClass: "missing_consent" | "unknown_consent_class";
      detail: string;
    } {
  if (value == null || value === "") {
    options.onTelemetry?.({
      event: "learning.consent",
      action: "shard_include",
      outcome: "rejected",
      subjectId: options.subjectId ?? null,
      ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
      failureClass: "missing_consent",
    });
    return {
      ok: false,
      failureClass: "missing_consent",
      detail: "corpus shard requires a recorded consent class",
    };
  }
  if (!isCorpusShardConsentClass(value)) {
    options.onTelemetry?.({
      event: "learning.consent",
      action: "shard_include",
      outcome: "rejected",
      subjectId: options.subjectId ?? null,
      ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
      failureClass: "unknown_consent_class",
    });
    return {
      ok: false,
      failureClass: "unknown_consent_class",
      detail:
        "unknown shard consent class — exclude (expected consented|public|synthetic|government)",
    };
  }
  return { ok: true, consentClass: value };
}

export type CorpusShardInclusionAccepted = {
  ok: true;
  shardId: string;
  consentClass: CorpusShardConsentClass;
  subjectId: string | null;
  idempotent: boolean;
};

export type CorpusShardInclusionRejected = {
  ok: false;
  failureClass: ConsentGateFailureClass;
  shardId: string | null;
  subjectId: string | null;
  detail: string;
};

export type CorpusShardInclusionResult =
  | CorpusShardInclusionAccepted
  | CorpusShardInclusionRejected;

export type CorpusShardInclusionOptions = ConsentGateOptions & {
  ledger?: SubjectConsentLedger;
  /**
   * Optional idempotency set of already-included shardIds (mutation only on
   * accept). Replays return ok with idempotent=true — never double-applied.
   */
  includedShardIds?: Set<string>;
};

/**
 * Corpus factory hook: include a shard only when its consent class is known
 * and path invariants hold. Unknown class = exclude (never silent include).
 */
export function evaluateCorpusShardInclusion(
  shard: CorpusShardCandidate,
  options: CorpusShardInclusionOptions = {},
): CorpusShardInclusionResult {
  const deviceId = shard.deviceId ?? options.deviceId;
  const subjectGuess =
    typeof shard.subjectId === "string" && shard.subjectId.length > 0
      ? shard.subjectId
      : null;

  const emit = (
    outcome: "ok" | "rejected",
    failureClass?: ConsentGateFailureClass,
    shardConsentClass?: CorpusShardConsentClass,
  ): void => {
    options.onTelemetry?.({
      event: "learning.consent",
      action: "shard_include",
      outcome,
      subjectId: subjectGuess,
      ...(deviceId !== undefined ? { deviceId } : {}),
      ...(failureClass !== undefined ? { failureClass } : {}),
      ...(shardConsentClass !== undefined ? { shardConsentClass } : {}),
      ...(typeof shard.shardId === "string" ? { shardId: shard.shardId } : {}),
    });
  };

  if (
    typeof shard.shardId !== "string" ||
    shard.shardId.length === 0 ||
    shard.shardId.length > CORPUS_SHARD_ID_LIMIT
  ) {
    emit("rejected", "shard_excluded");
    return {
      ok: false,
      failureClass: "shard_excluded",
      shardId: null,
      subjectId: subjectGuess,
      detail: `shardId required (1..${CORPUS_SHARD_ID_LIMIT} chars)`,
    };
  }

  if (
    typeof shard.contentHash !== "string" ||
    shard.contentHash.length === 0 ||
    shard.contentHash.length > CORPUS_SHARD_HASH_LIMIT
  ) {
    emit("rejected", "shard_excluded");
    return {
      ok: false,
      failureClass: "shard_excluded",
      shardId: shard.shardId,
      subjectId: subjectGuess,
      detail: `contentHash required (1..${CORPUS_SHARD_HASH_LIMIT} chars)`,
    };
  }

  const parsed = parseCorpusShardConsentClass(shard.consentClass, {
    subjectId: subjectGuess,
    ...(deviceId !== undefined ? { deviceId } : {}),
  });
  if (!parsed.ok) {
    emit("rejected", parsed.failureClass);
    return {
      ok: false,
      failureClass: parsed.failureClass,
      shardId: shard.shardId,
      subjectId: subjectGuess,
      detail: parsed.detail,
    };
  }

  if (parsed.consentClass === "consented") {
    if (!subjectGuess) {
      emit("rejected", "missing_subject", parsed.consentClass);
      return {
        ok: false,
        failureClass: "missing_subject",
        shardId: shard.shardId,
        subjectId: null,
        detail: "consented shards require subjectId",
      };
    }
    if (options.ledger?.isRevoked(subjectGuess)) {
      emit("rejected", "consent_revoked", parsed.consentClass);
      return {
        ok: false,
        failureClass: "consent_revoked",
        shardId: shard.shardId,
        subjectId: subjectGuess,
        detail: "revoked subject excluded from future corpus builds",
      };
    }
  }

  if (shard.crossSubject === true && shard.anonymized !== true) {
    emit("rejected", "cross_subject", parsed.consentClass);
    return {
      ok: false,
      failureClass: "cross_subject",
      shardId: shard.shardId,
      subjectId: subjectGuess,
      detail:
        "cross-subject shard aggregation requires anonymization + consent class",
    };
  }

  if (
    shard.requiresThirdPartyProcessing === true &&
    !(THIRD_PARTY_ELIGIBLE_SHARD_CLASSES as readonly string[]).includes(
      parsed.consentClass,
    )
  ) {
    emit("rejected", "third_party_excluded", parsed.consentClass);
    return {
      ok: false,
      failureClass: "third_party_excluded",
      shardId: shard.shardId,
      subjectId: subjectGuess,
      detail:
        "third-party teacher path excludes government shard consent class",
    };
  }

  const already = options.includedShardIds?.has(shard.shardId) === true;
  if (!already) {
    options.includedShardIds?.add(shard.shardId);
  }

  emit("ok", undefined, parsed.consentClass);
  return {
    ok: true,
    shardId: shard.shardId,
    consentClass: parsed.consentClass,
    subjectId: subjectGuess,
    idempotent: already,
  };
}

/**
 * Batch corpus factory filter — bounded; each shard evaluated independently.
 * Unknown / missing classes are excluded with distinct failure signals.
 */
export function filterCorpusShardsForInclusion(
  shards: readonly CorpusShardCandidate[],
  options: CorpusShardInclusionOptions = {},
): {
  included: CorpusShardInclusionAccepted[];
  excluded: CorpusShardInclusionRejected[];
} {
  if (shards.length > CORPUS_SHARD_BATCH_LIMIT) {
    options.onTelemetry?.({
      event: "learning.consent",
      action: "shard_include",
      outcome: "rejected",
      subjectId: options.subjectId ?? null,
      ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
      failureClass: "batch_limit",
    });
    return {
      included: [],
      excluded: [
        {
          ok: false,
          failureClass: "batch_limit",
          shardId: null,
          subjectId: options.subjectId ?? null,
          detail: `shard batch exceeds ${CORPUS_SHARD_BATCH_LIMIT}`,
        },
      ],
    };
  }

  const included: CorpusShardInclusionAccepted[] = [];
  const excluded: CorpusShardInclusionRejected[] = [];
  const includedShardIds = options.includedShardIds ?? new Set<string>();

  for (const shard of shards) {
    const result = evaluateCorpusShardInclusion(shard, {
      ...options,
      includedShardIds,
    });
    if (result.ok) {
      included.push(result);
    } else {
      excluded.push(result);
    }
  }

  return { included, excluded };
}

export type AcceptedShardFixtureDocument = {
  schemaVersion: typeof CONSENT_GATE_FIXTURE_SCHEMA_VERSION;
  purpose: string;
  shards: CorpusShardCandidate[];
};

/**
 * Every accepted shard fixture must carry a known corpus consent class.
 * Missing / unknown → reject (never silent include).
 */
export function assertAcceptedShardFixturesHaveConsentClass(
  shards: readonly CorpusShardCandidate[],
  options: ConsentGateOptions = {},
):
  | {
      ok: true;
      count: number;
      consentClasses: CorpusShardConsentClass[];
    }
  | {
      ok: false;
      failureClass: ConsentGateFailureClass;
      subjectId: string | null;
      detail: string;
      failingShardId: string | null;
    } {
  if (shards.length === 0) {
    return {
      ok: false,
      failureClass: "missing_consent",
      subjectId: options.subjectId ?? null,
      detail: "accepted shard fixture set is empty",
      failingShardId: null,
    };
  }
  if (shards.length > CORPUS_SHARD_BATCH_LIMIT) {
    return {
      ok: false,
      failureClass: "batch_limit",
      subjectId: options.subjectId ?? null,
      detail: `accepted shard fixtures exceed ${CORPUS_SHARD_BATCH_LIMIT}`,
      failingShardId: null,
    };
  }

  const { included, excluded } = filterCorpusShardsForInclusion(shards, {
    ...options,
    includedShardIds: new Set<string>(),
  });

  if (excluded.length > 0) {
    const first = excluded[0]!;
    return {
      ok: false,
      failureClass: first.failureClass,
      subjectId: first.subjectId,
      detail: first.detail,
      failingShardId: first.shardId,
    };
  }

  for (const row of included) {
    if (!isCorpusShardConsentClass(row.consentClass)) {
      return {
        ok: false,
        failureClass: "unknown_consent_class",
        subjectId: row.subjectId,
        detail: "accepted fixture lost consent class after inclusion",
        failingShardId: row.shardId,
      };
    }
  }

  options.onTelemetry?.({
    event: "learning.consent",
    action: "shard_include",
    outcome: "ok",
    subjectId: options.subjectId ?? null,
    ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
  });

  return {
    ok: true,
    count: included.length,
    consentClasses: included.map((r) => r.consentClass),
  };
}

export async function loadAcceptedShardFixtures(opts: {
  repoRoot: string;
  deviceId?: string;
  onTelemetry?: (event: ConsentGateTelemetryEvent) => void;
}): Promise<
  | { ok: true; document: AcceptedShardFixtureDocument; absPath: string }
  | {
      ok: false;
      failureClass: ConsentGateFailureClass;
      detail: string;
    }
> {
  const absPath = path.join(
    opts.repoRoot,
    CONSENT_GATE_FIXTURES_RELPATH,
    CONSENT_ACCEPTED_SHARDS_FIXTURE,
  );
  let text: string;
  try {
    text = await readFile(absPath, "utf8");
  } catch {
    opts.onTelemetry?.({
      event: "learning.consent",
      action: "shard_include",
      outcome: "rejected",
      subjectId: null,
      ...(opts.deviceId !== undefined ? { deviceId: opts.deviceId } : {}),
      failureClass: "missing_consent",
    });
    return {
      ok: false,
      failureClass: "missing_consent",
      detail: `missing fixture: ${CONSENT_ACCEPTED_SHARDS_FIXTURE}`,
    };
  }

  if (text.length > CONSENT_FIXTURE_BYTES_LIMIT) {
    return {
      ok: false,
      failureClass: "batch_limit",
      detail: `fixture exceeds ${CONSENT_FIXTURE_BYTES_LIMIT} bytes`,
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {
      ok: false,
      failureClass: "shard_excluded",
      detail: "accepted-shards fixture is not valid JSON",
    };
  }

  if (
    !raw ||
    typeof raw !== "object" ||
    (raw as { schemaVersion?: unknown }).schemaVersion !==
      CONSENT_GATE_FIXTURE_SCHEMA_VERSION ||
    !Array.isArray((raw as { shards?: unknown }).shards)
  ) {
    return {
      ok: false,
      failureClass: "shard_excluded",
      detail: "accepted-shards fixture schema_violation",
    };
  }

  return {
    ok: true,
    document: raw as AcceptedShardFixtureDocument,
    absPath,
  };
}

export async function loadConsentFixtureJson(opts: {
  repoRoot: string;
  fixtureFile: string;
}): Promise<
  | { ok: true; value: unknown }
  | { ok: false; failureClass: ConsentGateFailureClass; detail: string }
> {
  if (
    opts.fixtureFile.includes("..") ||
    opts.fixtureFile.includes("/") ||
    opts.fixtureFile.includes("\\") ||
    !opts.fixtureFile.endsWith(".json")
  ) {
    return {
      ok: false,
      failureClass: "shard_excluded",
      detail: "fixtureFile must be a bare *.json name",
    };
  }
  const abs = path.join(
    opts.repoRoot,
    CONSENT_GATE_FIXTURES_RELPATH,
    opts.fixtureFile,
  );
  try {
    const text = await readFile(abs, "utf8");
    if (text.length > CONSENT_FIXTURE_BYTES_LIMIT) {
      return {
        ok: false,
        failureClass: "batch_limit",
        detail: `fixture exceeds ${CONSENT_FIXTURE_BYTES_LIMIT} bytes`,
      };
    }
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return {
      ok: false,
      failureClass: "missing_consent",
      detail: `missing fixture: ${opts.fixtureFile}`,
    };
  }
}

/** Type alias for callers that already use TrajectoryConsentClass. */
export type { TrajectoryConsentClass };
