/**
 * Consent-gated trajectory export API.
 *
 * Export rejects trajectories without a consent record. Async write path
 * returns immediately so the turn hot-path is never blocked on durable I/O.
 */

import {
  CONSENT_NEGATIVE_FEDERATED_FIXTURE,
  CONSENT_NEGATIVE_OPT_OUT_FIXTURE,
  assertAcceptedShardFixturesHaveConsentClass,
  evaluateCorpusShardInclusion,
  evaluateTrajectoryConsent,
  loadAcceptedShardFixtures,
  loadConsentFixtureJson,
  type ConsentGateFailureClass,
  type ConsentGateTelemetryEvent,
  type CorpusShardCandidate,
  type CorpusShardInclusionOptions,
  type CorpusShardInclusionResult,
  type SubjectConsentLedger,
} from "./consent_gate.js";
import {
  enqueueTrajectoryWrite,
  parseTurnTrajectoryRecord,
  type TurnTrajectoryRecord,
} from "./trajectory_schema.js";

export type TrajectoryExportFailureClass =
  | ConsentGateFailureClass
  | "export_rejected"
  | "write_failed";

export type TrajectoryExportTelemetryEvent = {
  event: "learning.trajectory.export";
  outcome: "ok" | "rejected" | "queued";
  subjectId: string | null;
  deviceId?: string;
  failureClass?: TrajectoryExportFailureClass;
  consentClass?: string;
  turnId?: string;
};

export type TrajectoryExportOptions = {
  deviceId?: string;
  /** Teacher distillation involving third-party frontier APIs. */
  requiresThirdPartyProcessing?: boolean;
  /** Federated / multi-subject aggregation attempt. */
  crossSubject?: boolean;
  anonymized?: boolean;
  ledger?: SubjectConsentLedger;
  onTelemetry?: (
    event: TrajectoryExportTelemetryEvent | ConsentGateTelemetryEvent,
  ) => void;
};

export type TrajectoryExportAccepted = {
  ok: true;
  subjectId: string;
  consentClass: string;
  record: TurnTrajectoryRecord;
};

export type TrajectoryExportRejected = {
  ok: false;
  failureClass: TrajectoryExportFailureClass;
  subjectId: string | null;
  detail: string;
};

export type TrajectoryExportResult =
  | TrajectoryExportAccepted
  | TrajectoryExportRejected;

/**
 * Synchronous export gate — reject without a consent record / opted-in class.
 * Does not persist; call enqueueConsentedTrajectoryWrite for durable I/O.
 */
export function exportTrajectory(
  record: TurnTrajectoryRecord,
  options: TrajectoryExportOptions = {},
): TrajectoryExportResult {
  const gate = evaluateTrajectoryConsent(
    {
      subjectId: record.subjectId,
      consent: record.consent,
      ...(record.deviceId !== undefined ? { deviceId: record.deviceId } : {}),
      ...(options.requiresThirdPartyProcessing !== undefined
        ? {
            requiresThirdPartyProcessing: options.requiresThirdPartyProcessing,
          }
        : {}),
      ...(options.crossSubject !== undefined
        ? { crossSubject: options.crossSubject }
        : {}),
      ...(options.anonymized !== undefined
        ? { anonymized: options.anonymized }
        : {}),
      ...(options.ledger !== undefined ? { ledger: options.ledger } : {}),
    },
    {
      subjectId: record.subjectId,
      ...(options.deviceId !== undefined
        ? { deviceId: options.deviceId }
        : record.deviceId !== undefined
          ? { deviceId: record.deviceId }
          : {}),
      ...(options.onTelemetry !== undefined
        ? { onTelemetry: options.onTelemetry }
        : {}),
    },
  );

  if (!gate.ok) {
    options.onTelemetry?.({
      event: "learning.trajectory.export",
      outcome: "rejected",
      subjectId: gate.subjectId,
      ...(record.deviceId !== undefined
        ? { deviceId: record.deviceId }
        : options.deviceId !== undefined
          ? { deviceId: options.deviceId }
          : {}),
      failureClass: gate.failureClass,
      turnId: record.turnId,
    });
    return {
      ok: false,
      failureClass: gate.failureClass,
      subjectId: gate.subjectId,
      detail: gate.detail,
    };
  }

  options.onTelemetry?.({
    event: "learning.trajectory.export",
    outcome: "ok",
    subjectId: gate.subjectId,
    ...(record.deviceId !== undefined
      ? { deviceId: record.deviceId }
      : options.deviceId !== undefined
        ? { deviceId: options.deviceId }
        : {}),
    consentClass: gate.consentClass,
    turnId: record.turnId,
  });

  return {
    ok: true,
    subjectId: gate.subjectId,
    consentClass: gate.consentClass,
    record,
  };
}

/**
 * Gate then queue durable write. Returns immediately (turn never waits on I/O).
 * Rejected consent → sync reject, writer never invoked.
 */
export function enqueueConsentedTrajectoryWrite(
  record: TurnTrajectoryRecord,
  writer: (record: TurnTrajectoryRecord) => void | Promise<void>,
  options: TrajectoryExportOptions = {},
):
  | { queued: true; subjectId: string; consentClass: string }
  | TrajectoryExportRejected {
  const gated = exportTrajectory(record, options);
  if (!gated.ok) {
    return gated;
  }

  const queued = enqueueTrajectoryWrite(record, writer, {
    onTelemetry: (e) => {
      options.onTelemetry?.({
        event: "learning.trajectory.export",
        outcome: e.outcome === "rejected" ? "rejected" : e.outcome,
        subjectId: e.subjectId,
        ...(e.deviceId !== undefined ? { deviceId: e.deviceId } : {}),
        ...(e.failureClass !== undefined
          ? { failureClass: "write_failed" }
          : {}),
        consentClass: gated.consentClass,
        turnId: record.turnId,
      });
    },
  });

  options.onTelemetry?.({
    event: "learning.trajectory.export",
    outcome: "queued",
    subjectId: queued.subjectId,
    ...(record.deviceId !== undefined ? { deviceId: record.deviceId } : {}),
    consentClass: gated.consentClass,
    turnId: record.turnId,
  });

  return {
    queued: true,
    subjectId: queued.subjectId,
    consentClass: gated.consentClass,
  };
}

/**
 * Map an opted-in B9 trajectory onto a corpus shard candidate (`consented`).
 * Teacher-synthetic traces may opt into the `synthetic` shard class.
 */
export function trajectoryToCorpusShardCandidate(
  record: TurnTrajectoryRecord,
  options: {
    contentHash: string;
    shardId?: string;
    shardConsentClass?: "consented" | "synthetic";
    requiresThirdPartyProcessing?: boolean;
    crossSubject?: boolean;
    anonymized?: boolean;
  },
): CorpusShardCandidate {
  const shardConsentClass = options.shardConsentClass ?? "consented";
  return {
    shardId: options.shardId ?? `traj:${record.turnId}`,
    contentHash: options.contentHash,
    consentClass: shardConsentClass,
    subjectId: record.subjectId,
    ...(record.deviceId !== undefined ? { deviceId: record.deviceId } : {}),
    locality: record.locality,
    ...(options.requiresThirdPartyProcessing !== undefined
      ? {
          requiresThirdPartyProcessing: options.requiresThirdPartyProcessing,
        }
      : {}),
    ...(options.crossSubject !== undefined
      ? { crossSubject: options.crossSubject }
      : {}),
    ...(options.anonymized !== undefined
      ? { anonymized: options.anonymized }
      : {}),
  };
}

/**
 * Export-gate then corpus-factory inclusion for a single trajectory shard.
 * Declined export / unknown or missing shard class → exclude (not silent).
 */
export function includeExportedTrajectoryInCorpus(
  record: TurnTrajectoryRecord,
  options: TrajectoryExportOptions & {
    contentHash: string;
    shardId?: string;
    shardConsentClass?: "consented" | "synthetic";
    includedShardIds?: Set<string>;
  },
):
  | {
      ok: true;
      export: TrajectoryExportAccepted;
      inclusion: Extract<CorpusShardInclusionResult, { ok: true }>;
    }
  | TrajectoryExportRejected
  | Extract<CorpusShardInclusionResult, { ok: false }> {
  const exported = exportTrajectory(record, options);
  if (!exported.ok) {
    return exported;
  }

  const shard = trajectoryToCorpusShardCandidate(record, {
    contentHash: options.contentHash,
    ...(options.shardId !== undefined ? { shardId: options.shardId } : {}),
    ...(options.shardConsentClass !== undefined
      ? { shardConsentClass: options.shardConsentClass }
      : {}),
    ...(options.requiresThirdPartyProcessing !== undefined
      ? {
          requiresThirdPartyProcessing: options.requiresThirdPartyProcessing,
        }
      : {}),
    ...(options.crossSubject !== undefined
      ? { crossSubject: options.crossSubject }
      : {}),
    ...(options.anonymized !== undefined
      ? { anonymized: options.anonymized }
      : {}),
  });

  const inclusionOpts: CorpusShardInclusionOptions = {
    subjectId: record.subjectId,
    ...(options.deviceId !== undefined
      ? { deviceId: options.deviceId }
      : record.deviceId !== undefined
        ? { deviceId: record.deviceId }
        : {}),
    ...(options.ledger !== undefined ? { ledger: options.ledger } : {}),
    ...(options.includedShardIds !== undefined
      ? { includedShardIds: options.includedShardIds }
      : {}),
    ...(options.onTelemetry !== undefined
      ? { onTelemetry: options.onTelemetry }
      : {}),
  };

  const inclusion = evaluateCorpusShardInclusion(shard, inclusionOpts);
  if (!inclusion.ok) {
    return inclusion;
  }

  return { ok: true, export: exported, inclusion };
}

/**
 * Integration prove for consent-law:
 * 1) every accepted shard fixture carries a consent class and includes
 * 2) opt-out trajectory fixture is blocked from export
 * 3) federated shard without anonymization is blocked
 *
 * Read-only over committed fixtures — idempotent for CI.
 */
export async function proveConsentGateIntegration(opts: {
  repoRoot: string;
  deviceId?: string;
  onTelemetry?: (
    event: TrajectoryExportTelemetryEvent | ConsentGateTelemetryEvent,
  ) => void;
}): Promise<
  | {
      ok: true;
      acceptedShardCount: number;
      optOutBlocked: true;
      federatedBlocked: true;
    }
  | {
      ok: false;
      failureClass: TrajectoryExportFailureClass;
      detail: string;
    }
> {
  const deviceId = opts.deviceId ?? "ci-consent-integration";

  const accepted = await loadAcceptedShardFixtures({
    repoRoot: opts.repoRoot,
    deviceId,
    ...(opts.onTelemetry !== undefined
      ? { onTelemetry: opts.onTelemetry }
      : {}),
  });
  if (!accepted.ok) {
    return {
      ok: false,
      failureClass: accepted.failureClass,
      detail: accepted.detail,
    };
  }

  const classGate = assertAcceptedShardFixturesHaveConsentClass(
    accepted.document.shards,
    {
      subjectId: null,
      deviceId,
      ...(opts.onTelemetry !== undefined
        ? { onTelemetry: opts.onTelemetry }
        : {}),
    },
  );
  if (!classGate.ok) {
    return {
      ok: false,
      failureClass: classGate.failureClass,
      detail: `${classGate.detail} (shard=${classGate.failingShardId ?? "?"})`,
    };
  }

  const optOutRaw = await loadConsentFixtureJson({
    repoRoot: opts.repoRoot,
    fixtureFile: CONSENT_NEGATIVE_OPT_OUT_FIXTURE,
  });
  if (!optOutRaw.ok) {
    return {
      ok: false,
      failureClass: optOutRaw.failureClass,
      detail: optOutRaw.detail,
    };
  }
  const optOutParsed = parseTurnTrajectoryRecord(optOutRaw.value);
  if (!optOutParsed.ok) {
    return {
      ok: false,
      failureClass: "export_rejected",
      detail: `opt-out fixture schema_violation: ${optOutParsed.detail}`,
    };
  }
  const optOutExport = exportTrajectory(optOutParsed.record, {
    deviceId,
    ...(opts.onTelemetry !== undefined
      ? { onTelemetry: opts.onTelemetry }
      : {}),
  });
  if (optOutExport.ok || optOutExport.failureClass !== "consent_denied") {
    return {
      ok: false,
      failureClass: "export_rejected",
      detail:
        "opt-out trajectory must be blocked from export with consent_denied",
    };
  }

  const fedRaw = await loadConsentFixtureJson({
    repoRoot: opts.repoRoot,
    fixtureFile: CONSENT_NEGATIVE_FEDERATED_FIXTURE,
  });
  if (!fedRaw.ok) {
    return {
      ok: false,
      failureClass: fedRaw.failureClass,
      detail: fedRaw.detail,
    };
  }
  const fedShard = fedRaw.value as CorpusShardCandidate;
  const fedGate = evaluateCorpusShardInclusion(fedShard, {
    deviceId,
    ...(opts.onTelemetry !== undefined
      ? { onTelemetry: opts.onTelemetry }
      : {}),
  });
  if (fedGate.ok || fedGate.failureClass !== "cross_subject") {
    return {
      ok: false,
      failureClass: "cross_subject",
      detail:
        "federated shard without anonymization must be blocked (cross_subject)",
    };
  }

  // Federated trajectory export path — same default-deny without anonymization.
  const federatedExportProbe = evaluateTrajectoryConsent(
    {
      subjectId: "anika-k",
      consent: {
        optedIn: true,
        consentClass: "research",
        recordedAt: "2026-07-15T18:00:00.000Z",
      },
      deviceId,
      crossSubject: true,
      anonymized: false,
    },
    {
      subjectId: "anika-k",
      deviceId,
      ...(opts.onTelemetry !== undefined
        ? { onTelemetry: opts.onTelemetry }
        : {}),
    },
  );
  if (
    federatedExportProbe.ok ||
    federatedExportProbe.failureClass !== "cross_subject"
  ) {
    return {
      ok: false,
      failureClass: "cross_subject",
      detail:
        "federated export path without anonymization must be blocked (cross_subject)",
    };
  }

  opts.onTelemetry?.({
    event: "learning.trajectory.export",
    outcome: "ok",
    subjectId: null,
    deviceId,
    consentClass: classGate.consentClasses.join(","),
  });

  return {
    ok: true,
    acceptedShardCount: classGate.count,
    optOutBlocked: true,
    federatedBlocked: true,
  };
}
