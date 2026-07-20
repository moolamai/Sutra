/**
 * Worked example breakthrough RFC (GRPO G=8 → G=6) — machine mirror of
 * docs/learning/research-intake/rfcs/RFC-2026-004-grpo-g8-to-g6.md.
 *
 * Proves research intake is not shelfware: concrete hypothesis, champion
 * comparison, micro-run, and manifest update path. Does not adopt pins.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { GRPO_CLIP_EPSILON } from "./grpo_advantage.js";
import { GRPO_GROUP_SIZE_MAX } from "./staleness_control.js";
import {
  ResearchIntakeRfcError,
  RESEARCH_RFC_ARCHIVE_LIMIT,
  RESEARCH_RFC_OPERATION_LIMIT,
  RESEARCH_RFC_PHRASE_LIMIT,
  archiveRejectedRfcExperiment,
  evaluateResearchRfcApprovalGate,
  resetResearchIntakeRfcState,
  type ResearchRfcFailureClass,
  type ResearchRfcTelemetryEvent,
} from "./research_intake_rfc.js";

export const RESEARCH_RFC_WORKED_EXAMPLE_RELPATH =
  "docs/learning/research-intake/rfcs/RFC-2026-004-grpo-g8-to-g6.md" as const;

export const RESEARCH_RFC_WORKED_EXAMPLE_ID = "RFC-2026-004" as const;

/** Champion pin mirrored in the worked RFC (G=8 max). */
export const RESEARCH_RFC_WORKED_CHAMPION_G = GRPO_GROUP_SIZE_MAX;

/** Challenger proposed in the worked RFC. */
export const RESEARCH_RFC_WORKED_CHALLENGER_G = 6 as const;

/** Clip ε unchanged in this worked example. */
export const RESEARCH_RFC_WORKED_CLIP_EPS = GRPO_CLIP_EPSILON;

export const RESEARCH_RFC_WORKED_EXAMPLE_REQUIRED_PHRASES = Object.freeze([
  "RFC-2026-004",
  "G=8",
  "G=6",
  "ε=0.2",
  "ties do not promote",
  "c4.mjs",
  "generate-tracks.mjs",
  "Micro-run",
  "Rollback plan",
  "Manifest change list",
  "adapter",
  "constitution amendment",
  "One surgery",
] as const);

const FORBIDDEN_CONTENT_KEY =
  /utterance|promptBody|replyBody|learnerContent|rawContent|secret/i;

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

const workedExampleReceipts = new Map<string, string>();

function emit(
  onTelemetry: ((e: ResearchRfcTelemetryEvent) => void) | undefined,
  event: ResearchRfcTelemetryEvent,
): void {
  onTelemetry?.(event);
}

function assertNoRawContent(
  value: unknown,
  pathLabel: string,
):
  | { ok: true }
  | { ok: false; failureClass: ResearchRfcFailureClass; detail: string } {
  if (value === null || value === undefined) return { ok: true };
  if (typeof value !== "object") return { ok: true };
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const nested = assertNoRawContent(value[i], `${pathLabel}[${i}]`);
      if (!nested.ok) return nested;
    }
    return { ok: true };
  }
  for (const [key, child] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (FORBIDDEN_CONTENT_KEY.test(key)) {
      return {
        ok: false,
        failureClass: "research_rfc.sovereignty",
        detail: `forbidden content key ${key} at ${pathLabel}`,
      };
    }
    const nested = assertNoRawContent(child, `${pathLabel}.${key}`);
    if (!nested.ok) return nested;
  }
  return { ok: true };
}

/**
 * Assert the worked-example RFC exists and encodes the GRPO experiment.
 */
export async function assertResearchIntakeWorkedExampleCoherent(input: {
  repoRoot: string;
  deviceId?: string;
  subjectId?: string;
  onTelemetry?: (e: ResearchRfcTelemetryEvent) => void;
}): Promise<
  | { ok: true }
  | { ok: false; failureClass: ResearchRfcFailureClass; detail: string }
> {
  if (input.subjectId !== undefined && !ID_RE.test(input.subjectId)) {
    return {
      ok: false,
      failureClass: "research_rfc.invalid_input",
      detail: "subjectId must match opaque id grammar",
    };
  }
  if (
    RESEARCH_RFC_WORKED_EXAMPLE_REQUIRED_PHRASES.length >
    RESEARCH_RFC_PHRASE_LIMIT
  ) {
    return {
      ok: false,
      failureClass: "research_rfc.section_limit",
      detail: "worked-example phrase list exceeds budget",
    };
  }
  if (
    RESEARCH_RFC_WORKED_CHAMPION_G !== 8 ||
    RESEARCH_RFC_WORKED_CHALLENGER_G !== 6 ||
    RESEARCH_RFC_WORKED_CLIP_EPS !== 0.2
  ) {
    return {
      ok: false,
      failureClass: "research_rfc.policy_gap",
      detail: "worked-example G/ε pins drifted from RFC contract",
    };
  }

  let body: string;
  try {
    body = await readFile(
      path.join(input.repoRoot, RESEARCH_RFC_WORKED_EXAMPLE_RELPATH),
      "utf8",
    );
  } catch {
    emit(input.onTelemetry, {
      event: "learning.research_intake.rfc",
      outcome: "rejected",
      subjectId: input.subjectId ?? null,
      ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      action: "assert_worked_example",
      rfcId: RESEARCH_RFC_WORKED_EXAMPLE_ID,
      failureClass: "research_rfc.policy_gap",
    });
    return {
      ok: false,
      failureClass: "research_rfc.policy_gap",
      detail: `missing worked example at ${RESEARCH_RFC_WORKED_EXAMPLE_RELPATH}`,
    };
  }

  for (const phrase of RESEARCH_RFC_WORKED_EXAMPLE_REQUIRED_PHRASES) {
    if (!body.includes(phrase)) {
      emit(input.onTelemetry, {
        event: "learning.research_intake.rfc",
        outcome: "rejected",
        subjectId: input.subjectId ?? null,
        ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
        action: "assert_worked_example",
        rfcId: RESEARCH_RFC_WORKED_EXAMPLE_ID,
        failureClass: "research_rfc.incomplete_template",
      });
      return {
        ok: false,
        failureClass: "research_rfc.incomplete_template",
        detail: `worked example missing phrase: ${phrase}`,
      };
    }
  }

  if (FORBIDDEN_CONTENT_KEY.test(body)) {
    // Document must not contain forbidden field names as content keys;
    // allow the word "utterance" only inside "no … utterance" prohibitions.
    const stripped = body.replace(
      /no raw learner \/ utterance bodies|never raw learner content|No raw learner \/ utterance/gi,
      "",
    );
    if (/\butterance\b|\bpromptBody\b|\breplyBody\b/i.test(stripped)) {
      return {
        ok: false,
        failureClass: "research_rfc.sovereignty",
        detail: "worked example must not embed raw content keys",
      };
    }
  }

  emit(input.onTelemetry, {
    event: "learning.research_intake.rfc",
    outcome: "ok",
    subjectId: input.subjectId ?? null,
    ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
    action: "assert_worked_example",
    rfcId: RESEARCH_RFC_WORKED_EXAMPLE_ID,
    status: "in_review",
  });
  return { ok: true };
}

/**
 * Validate a GRPO hyperparameter experiment proposal against the worked-example
 * contract (champion G → challenger G, ε pin, one surgery).
 */
export function evaluateGrpoHyperparameterExperimentProposal(input: {
  request: {
    operationId: string;
    rfcId: string;
    championGroupSize: number;
    challengerGroupSize: number;
    clipEps: number;
    surgeryClass: string;
    manifestPaths: readonly string[];
    microRunDocumented: boolean;
    subjectId?: string;
    deviceId?: string;
    utterance?: unknown;
  };
  onTelemetry?: (e: ResearchRfcTelemetryEvent) => void;
}):
  | {
      ok: true;
      rfcId: string;
      status: "experiment_running";
      idempotentReplay: boolean;
    }
  | {
      ok: false;
      failureClass: ResearchRfcFailureClass;
      detail: string;
    } {
  const req = input.request;
  const sovereignty = assertNoRawContent(req, "request");
  if (!sovereignty.ok) {
    emit(input.onTelemetry, {
      event: "learning.research_intake.rfc",
      outcome: "rejected",
      subjectId: req.subjectId ?? null,
      ...(req.deviceId !== undefined ? { deviceId: req.deviceId } : {}),
      action: "evaluate_grpo_proposal",
      rfcId: req.rfcId,
      failureClass: sovereignty.failureClass,
    });
    return sovereignty;
  }
  if (!ID_RE.test(req.operationId) || !ID_RE.test(req.rfcId)) {
    return {
      ok: false,
      failureClass: "research_rfc.invalid_input",
      detail: "operationId/rfcId must match opaque id grammar",
    };
  }
  if (req.subjectId !== undefined && !ID_RE.test(req.subjectId)) {
    return {
      ok: false,
      failureClass: "research_rfc.invalid_input",
      detail: "subjectId must match opaque id grammar",
    };
  }
  if (workedExampleReceipts.size >= RESEARCH_RFC_OPERATION_LIMIT) {
    return {
      ok: false,
      failureClass: "research_rfc.section_limit",
      detail: `proposal receipts exceed ${RESEARCH_RFC_OPERATION_LIMIT}`,
    };
  }

  const prior = workedExampleReceipts.get(req.operationId);
  if (prior !== undefined) {
    if (prior !== req.rfcId) {
      return {
        ok: false,
        failureClass: "research_rfc.idempotent_conflict",
        detail: "operationId already bound to a different rfcId",
      };
    }
    emit(input.onTelemetry, {
      event: "learning.research_intake.rfc",
      outcome: "ok",
      subjectId: req.subjectId ?? null,
      ...(req.deviceId !== undefined ? { deviceId: req.deviceId } : {}),
      action: "evaluate_grpo_proposal",
      rfcId: req.rfcId,
      status: "experiment_running",
      operationId: req.operationId,
    });
    return {
      ok: true,
      rfcId: req.rfcId,
      status: "experiment_running",
      idempotentReplay: true,
    };
  }

  if (
    req.championGroupSize !== RESEARCH_RFC_WORKED_CHAMPION_G ||
    req.challengerGroupSize !== RESEARCH_RFC_WORKED_CHALLENGER_G ||
    req.clipEps !== RESEARCH_RFC_WORKED_CLIP_EPS
  ) {
    emit(input.onTelemetry, {
      event: "learning.research_intake.rfc",
      outcome: "rejected",
      subjectId: req.subjectId ?? null,
      ...(req.deviceId !== undefined ? { deviceId: req.deviceId } : {}),
      action: "evaluate_grpo_proposal",
      rfcId: req.rfcId,
      failureClass: "research_rfc.incomplete_template",
    });
    return {
      ok: false,
      failureClass: "research_rfc.incomplete_template",
      detail: `proposal must be champion G=${RESEARCH_RFC_WORKED_CHAMPION_G} → challenger G=${RESEARCH_RFC_WORKED_CHALLENGER_G} with ε=${RESEARCH_RFC_WORKED_CLIP_EPS}`,
    };
  }
  if (req.surgeryClass !== "adapter") {
    return {
      ok: false,
      failureClass: "research_rfc.incomplete_template",
      detail: "worked example requires surgery class adapter",
    };
  }
  if (!req.microRunDocumented) {
    return {
      ok: false,
      failureClass: "research_rfc.incomplete_template",
      detail: "micro-run must be documented",
    };
  }
  if (req.manifestPaths.length === 0 || req.manifestPaths.length > 8) {
    return {
      ok: false,
      failureClass: "research_rfc.section_limit",
      detail: "manifest path list must be non-empty and bounded",
    };
  }
  const hasC4 = req.manifestPaths.some((p) => p.includes("c4.mjs"));
  if (!hasC4) {
    return {
      ok: false,
      failureClass: "research_rfc.incomplete_template",
      detail: "manifest change list must include c4.mjs",
    };
  }

  workedExampleReceipts.set(req.operationId, req.rfcId);
  emit(input.onTelemetry, {
    event: "learning.research_intake.rfc",
    outcome: "ok",
    subjectId: req.subjectId ?? null,
    ...(req.deviceId !== undefined ? { deviceId: req.deviceId } : {}),
    action: "evaluate_grpo_proposal",
    rfcId: req.rfcId,
    status: "experiment_running",
    operationId: req.operationId,
  });
  return {
    ok: true,
    rfcId: req.rfcId,
    status: "experiment_running",
    idempotentReplay: false,
  };
}

export function resetResearchIntakeWorkedExampleState(): void {
  workedExampleReceipts.clear();
  resetResearchIntakeRfcState();
}

export type ResearchIntakeWorkedExampleProof = {
  ok: true;
  docsCoherent: boolean;
  proposalAccepted: boolean;
  incompleteProposalRejected: boolean;
  silentBypassRejected: boolean;
  rejectedArchived: boolean;
  gateWouldApproveWithExperiment: boolean;
};

/**
 * Prove worked-example RFC coherence + proposal / gate edge cases.
 */
export async function proveResearchIntakeWorkedExample(input: {
  repoRoot: string;
  deviceId?: string;
  onTelemetry?: (e: ResearchRfcTelemetryEvent) => void;
}): Promise<ResearchIntakeWorkedExampleProof> {
  resetResearchIntakeWorkedExampleState();
  const deviceId = input.deviceId ?? "device.research-rfc.worked";

  if (rejectedArchiveBudgetExceeded()) {
    throw new ResearchIntakeRfcError("archive budget exceeded before proof", {
      obligation: "research_rfc.section_limit",
    });
  }

  const coherent = await assertResearchIntakeWorkedExampleCoherent({
    repoRoot: input.repoRoot,
    deviceId,
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });

  const proposal = evaluateGrpoHyperparameterExperimentProposal({
    request: {
      operationId: "op.rfc.worked.propose",
      rfcId: RESEARCH_RFC_WORKED_EXAMPLE_ID,
      championGroupSize: RESEARCH_RFC_WORKED_CHAMPION_G,
      challengerGroupSize: RESEARCH_RFC_WORKED_CHALLENGER_G,
      clipEps: RESEARCH_RFC_WORKED_CLIP_EPS,
      surgeryClass: "adapter",
      manifestPaths: [
        "docs/stages/tracks/_generator/track-c/c4.mjs",
        "training/hyperparameters/grpo-group-size.json",
      ],
      microRunDocumented: true,
      deviceId,
    },
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });

  const incomplete = evaluateGrpoHyperparameterExperimentProposal({
    request: {
      operationId: "op.rfc.worked.bad-g",
      rfcId: "RFC-2026-005",
      championGroupSize: 8,
      challengerGroupSize: 7,
      clipEps: 0.2,
      surgeryClass: "adapter",
      manifestPaths: ["docs/stages/tracks/_generator/track-c/c4.mjs"],
      microRunDocumented: true,
      deviceId,
    },
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });

  const silent = evaluateResearchRfcApprovalGate({
    request: {
      operationId: "op.rfc.worked.silent",
      rfcId: RESEARCH_RFC_WORKED_EXAMPLE_ID,
      status: "emergency_bypass",
      sections: {
        hypothesis: true,
        relatedWork: true,
        evalPlanVsChampion: true,
        rollbackPlan: true,
        manifestChangeList: true,
      },
      approvals: { "track-c-maintainer": "approve" },
      requiresSafetyReview: true,
      touchesConstitutionLaws: true,
      experiment: {
        completed: false,
        challengerStrictlyBeatsChampion: false,
        safetySuitesGreen: false,
      },
      manifestChangeCount: 0,
      constitutionAmendmentRecordId: null,
      deviceId,
    },
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });

  const archived = archiveRejectedRfcExperiment({
    operationId: "op.rfc.worked.archive",
    rfcId: "RFC-2026-005",
    experimentReceiptId: "exp.worked.005",
    archivedAt: "2026-07-17T18:00:00.000Z",
    deviceId,
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });

  const gate = evaluateResearchRfcApprovalGate({
    request: {
      operationId: "op.rfc.worked.gate",
      rfcId: RESEARCH_RFC_WORKED_EXAMPLE_ID,
      status: "experiment_running",
      sections: {
        hypothesis: true,
        relatedWork: true,
        evalPlanVsChampion: true,
        rollbackPlan: true,
        manifestChangeList: true,
      },
      approvals: {
        author: "approve",
        "track-c-maintainer": "approve",
        "safety-reviewer": "approve",
      },
      requiresSafetyReview: true,
      touchesConstitutionLaws: false,
      experiment: {
        completed: true,
        challengerStrictlyBeatsChampion: true,
        safetySuitesGreen: true,
      },
      manifestChangeCount: 2,
      deviceId,
    },
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });

  const proof: ResearchIntakeWorkedExampleProof = {
    ok: true,
    docsCoherent: coherent.ok === true,
    proposalAccepted: proposal.ok === true && proposal.idempotentReplay === false,
    incompleteProposalRejected:
      !incomplete.ok &&
      incomplete.failureClass === "research_rfc.incomplete_template",
    silentBypassRejected:
      !silent.ok &&
      silent.failureClass === "research_rfc.silent_bypass_forbidden",
    rejectedArchived: archived.ok === true && archived.idempotentReplay === false,
    gateWouldApproveWithExperiment:
      gate.ok === true && gate.status === "approved",
  };

  if (
    !proof.docsCoherent ||
    !proof.proposalAccepted ||
    !proof.incompleteProposalRejected ||
    !proof.silentBypassRejected ||
    !proof.rejectedArchived ||
    !proof.gateWouldApproveWithExperiment
  ) {
    throw new ResearchIntakeRfcError(
      "research-intake worked-example proof failed",
      { obligation: "research_rfc.policy_gap" },
    );
  }
  return proof;
}

function rejectedArchiveBudgetExceeded(): boolean {
  // Guardrail: archive helper shares global budget with research_intake_rfc.
  return RESEARCH_RFC_ARCHIVE_LIMIT < 1;
}
