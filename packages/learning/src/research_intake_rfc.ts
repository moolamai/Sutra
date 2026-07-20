/**
 * Research-intake breakthrough RFC — machine mirror of
 * docs/learning/research-intake/{RFC_TEMPLATE,REVIEW_WORKFLOW}.md and the
 * Track C generator hook under docs/stages/tracks/_generator/track-c/.
 *
 * No learning-algorithm change ships without an approved RFC + champion
 * comparison; adopted RFCs update generator manifests and regenerate.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

export const RESEARCH_RFC_TEMPLATE_RELPATH =
  "docs/learning/research-intake/RFC_TEMPLATE.md" as const;
export const RESEARCH_RFC_WORKFLOW_RELPATH =
  "docs/learning/research-intake/REVIEW_WORKFLOW.md" as const;
export const RESEARCH_RFC_GENERATOR_HOOK_RELPATH =
  "docs/learning/research-intake/GENERATOR_HOOK.md" as const;

export const RESEARCH_RFC_SCHEMA_VERSION =
  "research.intake.rfc.v1" as const;

export const RESEARCH_RFC_REVIEW_ROLES = Object.freeze([
  "author",
  "track-c-maintainer",
  "safety-reviewer",
  "constitution-steward",
] as const);

export type ResearchRfcReviewRole =
  (typeof RESEARCH_RFC_REVIEW_ROLES)[number];

export const RESEARCH_RFC_STATUSES = Object.freeze([
  "draft",
  "in_review",
  "experiment_running",
  "approved",
  "rejected",
  "adopted",
  "emergency_bypass",
] as const);

export type ResearchRfcStatus = (typeof RESEARCH_RFC_STATUSES)[number];

export const RESEARCH_RFC_PHRASE_LIMIT = 32 as const;
export const RESEARCH_RFC_OPERATION_LIMIT = 256 as const;
export const RESEARCH_RFC_ARCHIVE_LIMIT = 128 as const;

/** Required phrases — template. */
export const RESEARCH_RFC_TEMPLATE_REQUIRED_PHRASES = Object.freeze([
  "Hypothesis",
  "Related work",
  "Eval plan vs champion",
  "Rollback plan",
  "Manifest change list",
  "ties do not promote",
  "One surgery",
] as const);

/** Required phrases — workflow. */
export const RESEARCH_RFC_WORKFLOW_REQUIRED_PHRASES = Object.freeze([
  "Review roles",
  "Approval gates",
  "Emergency safety patch",
  "Rejected RFC archive",
  "constitution amendment",
  "Track C maintainer",
  "Safety reviewer",
] as const);

/** Required phrases — generator hook. */
export const RESEARCH_RFC_GENERATOR_REQUIRED_PHRASES = Object.freeze([
  "generate-tracks.mjs",
  "Adopted research",
  "manifest",
  "One-off trainer forks",
] as const);

export type ResearchRfcFailureClass =
  | "research_rfc.invalid_input"
  | "research_rfc.incomplete_template"
  | "research_rfc.role_missing"
  | "research_rfc.experiment_incomplete"
  | "research_rfc.champion_not_beaten"
  | "research_rfc.silent_bypass_forbidden"
  | "research_rfc.amendment_missing"
  | "research_rfc.sovereignty"
  | "research_rfc.cross_subject"
  | "research_rfc.idempotent_conflict"
  | "research_rfc.section_limit"
  | "research_rfc.policy_gap"
  | "research_rfc.capacity"
  | "research_rfc.rejected_not_archived";

export class ResearchIntakeRfcError extends Error {
  readonly obligation: ResearchRfcFailureClass;
  readonly rfcId: string | undefined;
  readonly subjectId: string | null | undefined;

  constructor(
    message: string,
    meta: {
      obligation: ResearchRfcFailureClass;
      rfcId?: string;
      subjectId?: string | null;
    },
  ) {
    super(message);
    this.name = "ResearchIntakeRfcError";
    this.obligation = meta.obligation;
    this.rfcId = meta.rfcId;
    this.subjectId = meta.subjectId;
  }
}

export type ResearchRfcTelemetryEvent = {
  event: "learning.research_intake.rfc";
  outcome: "ok" | "rejected" | "idempotent_replay";
  subjectId: string | null;
  deviceId?: string;
  rfcId?: string;
  action?:
    | "assert_docs"
    | "assert_worked_example"
    | "evaluate_gate"
    | "evaluate_grpo_proposal"
    | "archive_rejected"
    | "emergency_bypass";
  status?: ResearchRfcStatus;
  failureClass?: ResearchRfcFailureClass;
  operationId?: string;
};

const FORBIDDEN_CONTENT_KEY =
  /utterance|promptBody|replyBody|learnerContent|rawContent|secret/i;
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

const gateReceipts = new Map<string, ResearchRfcApprovalDecision>();
const rejectedArchives = new Map<string, ResearchRfcArchiveRecord>();

function emit(
  onTelemetry: ((e: ResearchRfcTelemetryEvent) => void) | undefined,
  event: ResearchRfcTelemetryEvent,
): void {
  onTelemetry?.(event);
}

function assertNoRawContent(
  value: unknown,
  meta: { rfcId?: string; subjectId?: string | null },
): void {
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_CONTENT_KEY.test(key)) {
      throw new ResearchIntakeRfcError(
        `research RFC forbids raw content field ${key}`,
        {
          obligation: "research_rfc.sovereignty",
          ...(meta.rfcId !== undefined ? { rfcId: meta.rfcId } : {}),
          ...(meta.subjectId !== undefined
            ? { subjectId: meta.subjectId }
            : {}),
        },
      );
    }
    assertNoRawContent(child, meta);
  }
}

function phrasesPresent(
  text: string,
  phrases: readonly string[],
): string | null {
  for (const phrase of phrases) {
    if (!text.includes(phrase)) return phrase;
  }
  return null;
}

/**
 * Assert template, workflow, and generator hook stay coherent.
 */
export async function assertResearchIntakeRfcDocumentsCoherent(input: {
  repoRoot: string;
  deviceId?: string;
  subjectId?: string | null;
  onTelemetry?: (e: ResearchRfcTelemetryEvent) => void;
}): Promise<
  | { ok: true }
  | { ok: false; failureClass: ResearchRfcFailureClass; detail: string }
> {
  const subjectId = input.subjectId ?? null;
  try {
    const template = await readFile(
      path.join(input.repoRoot, RESEARCH_RFC_TEMPLATE_RELPATH),
      "utf8",
    );
    const workflow = await readFile(
      path.join(input.repoRoot, RESEARCH_RFC_WORKFLOW_RELPATH),
      "utf8",
    );
    const generator = await readFile(
      path.join(input.repoRoot, RESEARCH_RFC_GENERATOR_HOOK_RELPATH),
      "utf8",
    );

    if (
      RESEARCH_RFC_TEMPLATE_REQUIRED_PHRASES.length >
        RESEARCH_RFC_PHRASE_LIMIT ||
      RESEARCH_RFC_WORKFLOW_REQUIRED_PHRASES.length >
        RESEARCH_RFC_PHRASE_LIMIT ||
      RESEARCH_RFC_GENERATOR_REQUIRED_PHRASES.length >
        RESEARCH_RFC_PHRASE_LIMIT
    ) {
      return {
        ok: false,
        failureClass: "research_rfc.section_limit",
        detail: "required phrase sets exceed soft cap",
      };
    }

    const missingTemplate = phrasesPresent(
      template,
      RESEARCH_RFC_TEMPLATE_REQUIRED_PHRASES,
    );
    if (missingTemplate !== null) {
      return {
        ok: false,
        failureClass: "research_rfc.incomplete_template",
        detail: `RFC template missing phrase: ${missingTemplate}`,
      };
    }
    const missingWorkflow = phrasesPresent(
      workflow,
      RESEARCH_RFC_WORKFLOW_REQUIRED_PHRASES,
    );
    if (missingWorkflow !== null) {
      return {
        ok: false,
        failureClass: "research_rfc.policy_gap",
        detail: `review workflow missing phrase: ${missingWorkflow}`,
      };
    }
    const missingGenerator = phrasesPresent(
      generator,
      RESEARCH_RFC_GENERATOR_REQUIRED_PHRASES,
    );
    if (missingGenerator !== null) {
      return {
        ok: false,
        failureClass: "research_rfc.policy_gap",
        detail: `generator hook missing phrase: ${missingGenerator}`,
      };
    }

    if (
      !template.includes("REVIEW_WORKFLOW.md") ||
      !workflow.includes("RFC_TEMPLATE.md") ||
      !generator.includes("RFC_TEMPLATE.md")
    ) {
      return {
        ok: false,
        failureClass: "research_rfc.policy_gap",
        detail: "research-intake docs must cross-link template and workflow",
      };
    }

    emit(input.onTelemetry, {
      event: "learning.research_intake.rfc",
      outcome: "ok",
      subjectId,
      ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      action: "assert_docs",
    });
    return { ok: true };
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : "failed to read research RFC docs";
    emit(input.onTelemetry, {
      event: "learning.research_intake.rfc",
      outcome: "rejected",
      subjectId,
      ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      action: "assert_docs",
      failureClass: "research_rfc.policy_gap",
    });
    return { ok: false, failureClass: "research_rfc.policy_gap", detail };
  }
}

export type ResearchRfcApprovalRequest = {
  operationId: string;
  rfcId: string;
  status: ResearchRfcStatus;
  /** Sections present in the filled RFC (metadata flags). */
  sections: {
    hypothesis: boolean;
    relatedWork: boolean;
    evalPlanVsChampion: boolean;
    rollbackPlan: boolean;
    manifestChangeList: boolean;
  };
  approvals: Partial<Record<ResearchRfcReviewRole, "approve" | "reject">>;
  requiresSafetyReview: boolean;
  touchesConstitutionLaws: boolean;
  experiment: {
    completed: boolean;
    challengerStrictlyBeatsChampion: boolean;
    safetySuitesGreen: boolean;
  };
  manifestChangeCount: number;
  /** Emergency bypass only. */
  constitutionAmendmentRecordId?: string | null;
  subjectId?: string | null;
  deviceId?: string;
};

export type ResearchRfcApprovalDecision =
  | {
      ok: true;
      rfcId: string;
      status: "approved" | "emergency_bypass";
      idempotentReplay: boolean;
    }
  | {
      ok: false;
      rfcId: string;
      failureClass: ResearchRfcFailureClass;
      detail: string;
    };

/**
 * Evaluate whether an RFC may move to approved / emergency_bypass.
 */
export function evaluateResearchRfcApprovalGate(input: {
  request: ResearchRfcApprovalRequest;
  onTelemetry?: (e: ResearchRfcTelemetryEvent) => void;
}): ResearchRfcApprovalDecision {
  const req = input.request;
  const subjectId = req.subjectId ?? null;

  try {
    assertNoRawContent(req, { rfcId: req.rfcId, subjectId });
  } catch (error) {
    if (error instanceof ResearchIntakeRfcError) {
      emit(input.onTelemetry, {
        event: "learning.research_intake.rfc",
        outcome: "rejected",
        subjectId,
        ...(req.deviceId !== undefined ? { deviceId: req.deviceId } : {}),
        action: "evaluate_gate",
        rfcId: req.rfcId,
        failureClass: error.obligation,
        operationId: req.operationId,
      });
      return {
        ok: false,
        rfcId: req.rfcId,
        failureClass: error.obligation,
        detail: error.message,
      };
    }
    throw error;
  }

  if (!ID_RE.test(req.operationId) || !ID_RE.test(req.rfcId)) {
    return {
      ok: false,
      rfcId: req.rfcId,
      failureClass: "research_rfc.invalid_input",
      detail: "rfcId and operationId must be stable metadata ids",
    };
  }
  if (!(RESEARCH_RFC_STATUSES as readonly string[]).includes(req.status)) {
    return {
      ok: false,
      rfcId: req.rfcId,
      failureClass: "research_rfc.invalid_input",
      detail: "unknown RFC status",
    };
  }

  const receiptKey = `${req.operationId}|${req.rfcId}`;
  const prior = gateReceipts.get(receiptKey);
  if (prior !== undefined) {
    emit(input.onTelemetry, {
      event: "learning.research_intake.rfc",
      outcome: "idempotent_replay",
      subjectId,
      ...(req.deviceId !== undefined ? { deviceId: req.deviceId } : {}),
      action: "evaluate_gate",
      rfcId: req.rfcId,
      operationId: req.operationId,
      ...(prior.ok ? { status: prior.status } : {}),
    });
    if (prior.ok) return { ...prior, idempotentReplay: true };
    return prior;
  }

  if (gateReceipts.size >= RESEARCH_RFC_OPERATION_LIMIT) {
    return {
      ok: false,
      rfcId: req.rfcId,
      failureClass: "research_rfc.capacity",
      detail: "research RFC gate receipt capacity exceeded",
    };
  }

  const sections = req.sections;
  if (
    !sections.hypothesis ||
    !sections.relatedWork ||
    !sections.evalPlanVsChampion ||
    !sections.rollbackPlan ||
    !sections.manifestChangeList
  ) {
    const decision: ResearchRfcApprovalDecision = {
      ok: false,
      rfcId: req.rfcId,
      failureClass: "research_rfc.incomplete_template",
      detail: "RFC missing required template sections",
    };
    gateReceipts.set(receiptKey, decision);
    emit(input.onTelemetry, {
      event: "learning.research_intake.rfc",
      outcome: "rejected",
      subjectId,
      ...(req.deviceId !== undefined ? { deviceId: req.deviceId } : {}),
      action: "evaluate_gate",
      rfcId: req.rfcId,
      failureClass: "research_rfc.incomplete_template",
      operationId: req.operationId,
    });
    return decision;
  }

  if (req.status === "emergency_bypass") {
    if (
      req.constitutionAmendmentRecordId === undefined ||
      req.constitutionAmendmentRecordId === null ||
      !ID_RE.test(req.constitutionAmendmentRecordId)
    ) {
      const decision: ResearchRfcApprovalDecision = {
        ok: false,
        rfcId: req.rfcId,
        failureClass: "research_rfc.silent_bypass_forbidden",
        detail:
          "emergency bypass requires an explicit constitution amendment record",
      };
      gateReceipts.set(receiptKey, decision);
      emit(input.onTelemetry, {
        event: "learning.research_intake.rfc",
        outcome: "rejected",
        subjectId,
        ...(req.deviceId !== undefined ? { deviceId: req.deviceId } : {}),
        action: "emergency_bypass",
        rfcId: req.rfcId,
        failureClass: "research_rfc.silent_bypass_forbidden",
        operationId: req.operationId,
      });
      return decision;
    }
    if (req.approvals["constitution-steward"] !== "approve") {
      const decision: ResearchRfcApprovalDecision = {
        ok: false,
        rfcId: req.rfcId,
        failureClass: "research_rfc.amendment_missing",
        detail: "emergency bypass requires constitution-steward approve",
      };
      gateReceipts.set(receiptKey, decision);
      return decision;
    }
    const decision: ResearchRfcApprovalDecision = {
      ok: true,
      rfcId: req.rfcId,
      status: "emergency_bypass",
      idempotentReplay: false,
    };
    gateReceipts.set(receiptKey, decision);
    emit(input.onTelemetry, {
      event: "learning.research_intake.rfc",
      outcome: "ok",
      subjectId,
      ...(req.deviceId !== undefined ? { deviceId: req.deviceId } : {}),
      action: "emergency_bypass",
      rfcId: req.rfcId,
      status: "emergency_bypass",
      operationId: req.operationId,
    });
    return decision;
  }

  if (req.approvals.author === "reject" || req.approvals["track-c-maintainer"] !== "approve") {
    const decision: ResearchRfcApprovalDecision = {
      ok: false,
      rfcId: req.rfcId,
      failureClass: "research_rfc.role_missing",
      detail: "track-c-maintainer approve required",
    };
    gateReceipts.set(receiptKey, decision);
    return decision;
  }
  if (
    req.requiresSafetyReview &&
    req.approvals["safety-reviewer"] !== "approve"
  ) {
    const decision: ResearchRfcApprovalDecision = {
      ok: false,
      rfcId: req.rfcId,
      failureClass: "research_rfc.role_missing",
      detail: "safety-reviewer approve required",
    };
    gateReceipts.set(receiptKey, decision);
    return decision;
  }
  if (
    req.touchesConstitutionLaws &&
    req.approvals["constitution-steward"] !== "approve"
  ) {
    const decision: ResearchRfcApprovalDecision = {
      ok: false,
      rfcId: req.rfcId,
      failureClass: "research_rfc.role_missing",
      detail: "constitution-steward approve required for L1–L6 impact",
    };
    gateReceipts.set(receiptKey, decision);
    return decision;
  }

  if (!req.experiment.completed) {
    const decision: ResearchRfcApprovalDecision = {
      ok: false,
      rfcId: req.rfcId,
      failureClass: "research_rfc.experiment_incomplete",
      detail: "champion comparison experiment not completed",
    };
    gateReceipts.set(receiptKey, decision);
    return decision;
  }
  if (
    !req.experiment.challengerStrictlyBeatsChampion ||
    !req.experiment.safetySuitesGreen
  ) {
    const decision: ResearchRfcApprovalDecision = {
      ok: false,
      rfcId: req.rfcId,
      failureClass: "research_rfc.champion_not_beaten",
      detail: "challenger must strictly beat champion with safety green",
    };
    gateReceipts.set(receiptKey, decision);
    return decision;
  }

  if (
    !Number.isInteger(req.manifestChangeCount) ||
    req.manifestChangeCount < 0 ||
    req.manifestChangeCount > RESEARCH_RFC_PHRASE_LIMIT
  ) {
    return {
      ok: false,
      rfcId: req.rfcId,
      failureClass: "research_rfc.section_limit",
      detail: "manifestChangeCount out of bounds",
    };
  }

  const decision: ResearchRfcApprovalDecision = {
    ok: true,
    rfcId: req.rfcId,
    status: "approved",
    idempotentReplay: false,
  };
  gateReceipts.set(receiptKey, decision);
  emit(input.onTelemetry, {
    event: "learning.research_intake.rfc",
    outcome: "ok",
    subjectId,
    ...(req.deviceId !== undefined ? { deviceId: req.deviceId } : {}),
    action: "evaluate_gate",
    rfcId: req.rfcId,
    status: "approved",
    operationId: req.operationId,
  });
  return decision;
}

export type ResearchRfcArchiveRecord = {
  rfcId: string;
  archivedAt: string;
  experimentReceiptId: string;
  subjectId: string | null;
};

/**
 * Archive experiment results for a rejected RFC (forward-looking evidence).
 */
export function archiveRejectedRfcExperiment(input: {
  operationId: string;
  rfcId: string;
  experimentReceiptId: string;
  archivedAt?: string;
  subjectId?: string | null;
  deviceId?: string;
  onTelemetry?: (e: ResearchRfcTelemetryEvent) => void;
}):
  | { ok: true; record: ResearchRfcArchiveRecord; idempotentReplay: boolean }
  | { ok: false; failureClass: ResearchRfcFailureClass; detail: string } {
  if (
    !ID_RE.test(input.operationId) ||
    !ID_RE.test(input.rfcId) ||
    !ID_RE.test(input.experimentReceiptId)
  ) {
    return {
      ok: false,
      failureClass: "research_rfc.invalid_input",
      detail: "archive ids must be stable metadata ids",
    };
  }
  const existing = rejectedArchives.get(input.rfcId);
  if (existing !== undefined) {
    if (existing.experimentReceiptId !== input.experimentReceiptId) {
      return {
        ok: false,
        failureClass: "research_rfc.idempotent_conflict",
        detail: "rejected RFC already archived with a different receipt",
      };
    }
    emit(input.onTelemetry, {
      event: "learning.research_intake.rfc",
      outcome: "idempotent_replay",
      subjectId: input.subjectId ?? null,
      ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      action: "archive_rejected",
      rfcId: input.rfcId,
      operationId: input.operationId,
    });
    return { ok: true, record: existing, idempotentReplay: true };
  }
  if (rejectedArchives.size >= RESEARCH_RFC_ARCHIVE_LIMIT) {
    return {
      ok: false,
      failureClass: "research_rfc.capacity",
      detail: "rejected RFC archive capacity exceeded",
    };
  }
  const record: ResearchRfcArchiveRecord = Object.freeze({
    rfcId: input.rfcId,
    archivedAt: input.archivedAt ?? new Date().toISOString(),
    experimentReceiptId: input.experimentReceiptId,
    subjectId: input.subjectId ?? null,
  });
  rejectedArchives.set(input.rfcId, record);
  emit(input.onTelemetry, {
    event: "learning.research_intake.rfc",
    outcome: "ok",
    subjectId: input.subjectId ?? null,
    ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
    action: "archive_rejected",
    rfcId: input.rfcId,
    status: "rejected",
    operationId: input.operationId,
  });
  return { ok: true, record, idempotentReplay: false };
}

export function getRejectedRfcArchive(
  rfcId: string,
): ResearchRfcArchiveRecord | undefined {
  return rejectedArchives.get(rfcId);
}

/** Clear gate receipts + archives (tests only). */
export function resetResearchIntakeRfcState(): void {
  gateReceipts.clear();
  rejectedArchives.clear();
}

export type ResearchIntakeRfcProof = {
  ok: true;
  docsCoherent: boolean;
  happyApproved: boolean;
  incompleteRejected: boolean;
  silentBypassRejected: boolean;
  rejectedArchived: boolean;
};

/**
 * Prove template/workflow/generator coherence + approval gate edge cases.
 */
export async function proveResearchIntakeRfcWorkflow(input: {
  repoRoot: string;
  deviceId?: string;
  onTelemetry?: (e: ResearchRfcTelemetryEvent) => void;
}): Promise<ResearchIntakeRfcProof> {
  resetResearchIntakeRfcState();
  const deviceId = input.deviceId ?? "device.research-rfc";
  const coherent = await assertResearchIntakeRfcDocumentsCoherent({
    repoRoot: input.repoRoot,
    deviceId,
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });

  const completeSections = {
    hypothesis: true,
    relatedWork: true,
    evalPlanVsChampion: true,
    rollbackPlan: true,
    manifestChangeList: true,
  };

  const happy = evaluateResearchRfcApprovalGate({
    request: {
      operationId: "op.rfc.approve",
      rfcId: "RFC-2026-001",
      status: "experiment_running",
      sections: completeSections,
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
      manifestChangeCount: 1,
      deviceId,
    },
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });

  const incomplete = evaluateResearchRfcApprovalGate({
    request: {
      operationId: "op.rfc.incomplete",
      rfcId: "RFC-2026-002",
      status: "in_review",
      sections: {
        ...completeSections,
        rollbackPlan: false,
      },
      approvals: { "track-c-maintainer": "approve" },
      requiresSafetyReview: false,
      touchesConstitutionLaws: false,
      experiment: {
        completed: true,
        challengerStrictlyBeatsChampion: true,
        safetySuitesGreen: true,
      },
      manifestChangeCount: 1,
      deviceId,
    },
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });

  const silent = evaluateResearchRfcApprovalGate({
    request: {
      operationId: "op.rfc.silent-bypass",
      rfcId: "RFC-2026-003",
      status: "emergency_bypass",
      sections: completeSections,
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
    operationId: "op.rfc.archive",
    rfcId: "RFC-2026-002",
    experimentReceiptId: "exp.receipt.002",
    archivedAt: "2026-07-17T17:00:00.000Z",
    deviceId,
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });

  const proof: ResearchIntakeRfcProof = {
    ok: true,
    docsCoherent: coherent.ok === true,
    happyApproved: happy.ok === true && happy.status === "approved",
    incompleteRejected:
      !incomplete.ok &&
      incomplete.failureClass === "research_rfc.incomplete_template",
    silentBypassRejected:
      !silent.ok &&
      silent.failureClass === "research_rfc.silent_bypass_forbidden",
    rejectedArchived: archived.ok === true && archived.idempotentReplay === false,
  };

  if (
    !proof.docsCoherent ||
    !proof.happyApproved ||
    !proof.incompleteRejected ||
    !proof.silentBypassRejected ||
    !proof.rejectedArchived
  ) {
    throw new ResearchIntakeRfcError(
      "research-intake RFC workflow proof failed",
      { obligation: "research_rfc.policy_gap" },
    );
  }
  return proof;
}
