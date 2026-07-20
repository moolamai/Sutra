/**
 * RFC adoption → manifest regeneration checklist — machine mirror of
 * docs/learning/research-intake/ADOPTION_CHECKLIST.md and CI lint for orphan
 * trainer flags without an RFC ref.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  ResearchIntakeRfcError,
  RESEARCH_RFC_OPERATION_LIMIT,
  RESEARCH_RFC_PHRASE_LIMIT,
  type ResearchRfcFailureClass,
  type ResearchRfcTelemetryEvent,
} from "./research_intake_rfc.js";

export const RESEARCH_RFC_ADOPTION_CHECKLIST_RELPATH =
  "docs/learning/research-intake/ADOPTION_CHECKLIST.md" as const;

export const RESEARCH_RFC_TRAINER_FLAGS_OK_FIXTURE =
  "docs/learning/research-intake/fixtures/trainer-flags-ok.json" as const;

export const RESEARCH_RFC_TRAINER_FLAGS_ORPHAN_FIXTURE =
  "docs/learning/research-intake/fixtures/trainer-flags-orphan.json" as const;

export const RESEARCH_RFC_TRAINER_FLAGS_SCHEMA_VERSION =
  "research.intake.trainer-flags.v1" as const;

export const RESEARCH_RFC_ADOPTION_REQUIRED_PHRASES = Object.freeze([
  "Approved RFC",
  "Update track-c manifest",
  "Regenerate",
  "Micro-run green",
  "PROGRESS update",
  "orphan trainer",
  "rfcRef",
  "generate-tracks.mjs",
  "constitution amendment",
  "One-off trainer forks",
] as const);

export const RESEARCH_RFC_ADOPTION_STEPS = Object.freeze([
  "approved",
  "manifestUpdated",
  "regenerated",
  "microRunGreen",
  "progressUpdated",
] as const);

export type ResearchRfcAdoptionStep =
  (typeof RESEARCH_RFC_ADOPTION_STEPS)[number];

export type ResearchRfcAdoptionFailureClass =
  | ResearchRfcFailureClass
  | "research_rfc.orphan_trainer_flag"
  | "research_rfc.adoption_incomplete"
  | "research_rfc.adoption_order";

const FORBIDDEN_CONTENT_KEY =
  /utterance|promptBody|replyBody|learnerContent|rawContent|secret/i;
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const RFC_REF_RE = /^RFC-\d{4}-\d{3}$/;

const adoptionReceipts = new Map<string, string>();

export type ResearchRfcAdoptionTelemetryEvent = Omit<
  ResearchRfcTelemetryEvent,
  "action" | "failureClass"
> & {
  action?:
    | ResearchRfcTelemetryEvent["action"]
    | "assert_adoption_checklist"
    | "evaluate_adoption"
    | "lint_trainer_flags"
    | "ci_prove";
  failureClass?: ResearchRfcAdoptionFailureClass;
  flagId?: string;
};

export type TrainerFlagRecord = {
  flagId: string;
  enabled: boolean;
  rfcRef?: string;
  orphanTrainerFork?: boolean;
  summary?: string;
};

export type TrainerFlagsDocument = {
  schemaVersion: string;
  flags: TrainerFlagRecord[];
};

function emit(
  onTelemetry: ((e: ResearchRfcAdoptionTelemetryEvent) => void) | undefined,
  event: ResearchRfcAdoptionTelemetryEvent,
): void {
  onTelemetry?.(event);
}

function assertNoRawContent(
  value: unknown,
  pathLabel: string,
):
  | { ok: true }
  | {
      ok: false;
      failureClass: ResearchRfcAdoptionFailureClass;
      detail: string;
    } {
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
 * Assert adoption checklist document stays coherent.
 */
export async function assertResearchIntakeAdoptionChecklistCoherent(input: {
  repoRoot: string;
  deviceId?: string;
  subjectId?: string;
  onTelemetry?: (e: ResearchRfcAdoptionTelemetryEvent) => void;
}): Promise<
  | { ok: true }
  | {
      ok: false;
      failureClass: ResearchRfcAdoptionFailureClass;
      detail: string;
    }
> {
  if (input.subjectId !== undefined && !ID_RE.test(input.subjectId)) {
    return {
      ok: false,
      failureClass: "research_rfc.invalid_input",
      detail: "subjectId must match opaque id grammar",
    };
  }
  if (
    RESEARCH_RFC_ADOPTION_REQUIRED_PHRASES.length > RESEARCH_RFC_PHRASE_LIMIT
  ) {
    return {
      ok: false,
      failureClass: "research_rfc.section_limit",
      detail: "adoption phrase list exceeds budget",
    };
  }

  let body: string;
  try {
    body = await readFile(
      path.join(input.repoRoot, RESEARCH_RFC_ADOPTION_CHECKLIST_RELPATH),
      "utf8",
    );
  } catch {
    emit(input.onTelemetry, {
      event: "learning.research_intake.rfc",
      outcome: "rejected",
      subjectId: input.subjectId ?? null,
      ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      action: "assert_adoption_checklist",
      failureClass: "research_rfc.policy_gap",
    });
    return {
      ok: false,
      failureClass: "research_rfc.policy_gap",
      detail: `missing ${RESEARCH_RFC_ADOPTION_CHECKLIST_RELPATH}`,
    };
  }

  for (const phrase of RESEARCH_RFC_ADOPTION_REQUIRED_PHRASES) {
    if (!body.includes(phrase)) {
      emit(input.onTelemetry, {
        event: "learning.research_intake.rfc",
        outcome: "rejected",
        subjectId: input.subjectId ?? null,
        ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
        action: "assert_adoption_checklist",
        failureClass: "research_rfc.incomplete_template",
      });
      return {
        ok: false,
        failureClass: "research_rfc.incomplete_template",
        detail: `adoption checklist missing phrase: ${phrase}`,
      };
    }
  }

  emit(input.onTelemetry, {
    event: "learning.research_intake.rfc",
    outcome: "ok",
    subjectId: input.subjectId ?? null,
    ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
    action: "assert_adoption_checklist",
  });
  return { ok: true };
}

/**
 * Evaluate ordered adoption checklist (approved → … → progress).
 */
export function evaluateResearchRfcAdoptionChecklist(input: {
  request: {
    operationId: string;
    rfcId: string;
    steps: Record<ResearchRfcAdoptionStep, boolean>;
    commitCitesRfc: boolean;
    constitutionAmendmentRecordId?: string | null;
    emergencyBypass?: boolean;
    subjectId?: string;
    deviceId?: string;
    utterance?: unknown;
  };
  onTelemetry?: (e: ResearchRfcAdoptionTelemetryEvent) => void;
}):
  | {
      ok: true;
      rfcId: string;
      status: "adopted";
      idempotentReplay: boolean;
    }
  | {
      ok: false;
      failureClass: ResearchRfcAdoptionFailureClass;
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
      action: "evaluate_adoption",
      rfcId: req.rfcId,
      failureClass: sovereignty.failureClass,
    });
    return sovereignty;
  }
  if (!ID_RE.test(req.operationId) || !RFC_REF_RE.test(req.rfcId)) {
    return {
      ok: false,
      failureClass: "research_rfc.invalid_input",
      detail: "operationId/rfcId must be well-formed (RFC-YYYY-NNN)",
    };
  }
  if (req.subjectId !== undefined && !ID_RE.test(req.subjectId)) {
    return {
      ok: false,
      failureClass: "research_rfc.invalid_input",
      detail: "subjectId must match opaque id grammar",
    };
  }
  if (adoptionReceipts.size >= RESEARCH_RFC_OPERATION_LIMIT) {
    return {
      ok: false,
      failureClass: "research_rfc.section_limit",
      detail: `adoption receipts exceed ${RESEARCH_RFC_OPERATION_LIMIT}`,
    };
  }

  const prior = adoptionReceipts.get(req.operationId);
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
      outcome: "idempotent_replay",
      subjectId: req.subjectId ?? null,
      ...(req.deviceId !== undefined ? { deviceId: req.deviceId } : {}),
      action: "evaluate_adoption",
      rfcId: req.rfcId,
      status: "adopted",
      operationId: req.operationId,
    });
    return {
      ok: true,
      rfcId: req.rfcId,
      status: "adopted",
      idempotentReplay: true,
    };
  }

  if (req.emergencyBypass === true) {
    const amendment = req.constitutionAmendmentRecordId;
    if (typeof amendment !== "string" || amendment.length === 0) {
      emit(input.onTelemetry, {
        event: "learning.research_intake.rfc",
        outcome: "rejected",
        subjectId: req.subjectId ?? null,
        ...(req.deviceId !== undefined ? { deviceId: req.deviceId } : {}),
        action: "evaluate_adoption",
        rfcId: req.rfcId,
        failureClass: "research_rfc.silent_bypass_forbidden",
      });
      return {
        ok: false,
        failureClass: "research_rfc.silent_bypass_forbidden",
        detail: "emergency bypass requires constitution amendment record",
      };
    }
  }

  const stepValues = RESEARCH_RFC_ADOPTION_STEPS.map(
    (step) => req.steps[step] === true,
  );
  const firstFalse = stepValues.indexOf(false);
  if (firstFalse !== -1) {
    const trueAfterGap = stepValues.slice(firstFalse + 1).some((v) => v);
    if (trueAfterGap) {
      emit(input.onTelemetry, {
        event: "learning.research_intake.rfc",
        outcome: "rejected",
        subjectId: req.subjectId ?? null,
        ...(req.deviceId !== undefined ? { deviceId: req.deviceId } : {}),
        action: "evaluate_adoption",
        rfcId: req.rfcId,
        failureClass: "research_rfc.adoption_order",
      });
      return {
        ok: false,
        failureClass: "research_rfc.adoption_order",
        detail: "adoption steps must complete in order",
      };
    }
    const step = RESEARCH_RFC_ADOPTION_STEPS[firstFalse]!;
    emit(input.onTelemetry, {
      event: "learning.research_intake.rfc",
      outcome: "rejected",
      subjectId: req.subjectId ?? null,
      ...(req.deviceId !== undefined ? { deviceId: req.deviceId } : {}),
      action: "evaluate_adoption",
      rfcId: req.rfcId,
      failureClass: "research_rfc.adoption_incomplete",
    });
    return {
      ok: false,
      failureClass: "research_rfc.adoption_incomplete",
      detail: `adoption checklist incomplete at step ${step}`,
    };
  }

  if (req.commitCitesRfc !== true) {
    return {
      ok: false,
      failureClass: "research_rfc.adoption_incomplete",
      detail: "adoption commit/PR must cite RFC-YYYY-NNN",
    };
  }

  adoptionReceipts.set(req.operationId, req.rfcId);
  emit(input.onTelemetry, {
    event: "learning.research_intake.rfc",
    outcome: "ok",
    subjectId: req.subjectId ?? null,
    ...(req.deviceId !== undefined ? { deviceId: req.deviceId } : {}),
    action: "evaluate_adoption",
    rfcId: req.rfcId,
    status: "adopted",
    operationId: req.operationId,
  });
  return {
    ok: true,
    rfcId: req.rfcId,
    status: "adopted",
    idempotentReplay: false,
  };
}

/**
 * Lint trainer flags — enabled / fork markers require rfcRef.
 */
export function lintResearchIntakeTrainerFlags(input: {
  document: TrainerFlagsDocument;
  subjectId?: string;
  deviceId?: string;
  onTelemetry?: (e: ResearchRfcAdoptionTelemetryEvent) => void;
}):
  | { ok: true; flagCount: number }
  | {
      ok: false;
      failureClass: ResearchRfcAdoptionFailureClass;
      detail: string;
      flagId?: string;
    } {
  const sovereignty = assertNoRawContent(input.document, "document");
  if (!sovereignty.ok) {
    emit(input.onTelemetry, {
      event: "learning.research_intake.rfc",
      outcome: "rejected",
      subjectId: input.subjectId ?? null,
      ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      action: "lint_trainer_flags",
      failureClass: sovereignty.failureClass,
    });
    return sovereignty;
  }
  if (input.document.schemaVersion !== RESEARCH_RFC_TRAINER_FLAGS_SCHEMA_VERSION) {
    return {
      ok: false,
      failureClass: "research_rfc.policy_gap",
      detail: `expected schema ${RESEARCH_RFC_TRAINER_FLAGS_SCHEMA_VERSION}`,
    };
  }
  if (
    !Array.isArray(input.document.flags) ||
    input.document.flags.length === 0 ||
    input.document.flags.length > RESEARCH_RFC_PHRASE_LIMIT
  ) {
    return {
      ok: false,
      failureClass: "research_rfc.section_limit",
      detail: "flags list must be non-empty and bounded",
    };
  }

  for (const flag of input.document.flags) {
    if (typeof flag.flagId !== "string" || !ID_RE.test(flag.flagId)) {
      return {
        ok: false,
        failureClass: "research_rfc.invalid_input",
        detail: "flagId must match opaque id grammar",
        ...(typeof flag.flagId === "string" ? { flagId: flag.flagId } : {}),
      };
    }
    const needsRfc =
      flag.enabled === true || flag.orphanTrainerFork === true;
    if (!needsRfc) continue;
    const ref = flag.rfcRef;
    if (typeof ref !== "string" || !RFC_REF_RE.test(ref)) {
      emit(input.onTelemetry, {
        event: "learning.research_intake.rfc",
        outcome: "rejected",
        subjectId: input.subjectId ?? null,
        ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
        action: "lint_trainer_flags",
        failureClass: "research_rfc.orphan_trainer_flag",
        flagId: flag.flagId,
      });
      return {
        ok: false,
        failureClass: "research_rfc.orphan_trainer_flag",
        detail: `orphan trainer flag ${flag.flagId} missing valid rfcRef`,
        flagId: flag.flagId,
      };
    }
  }

  emit(input.onTelemetry, {
    event: "learning.research_intake.rfc",
    outcome: "ok",
    subjectId: input.subjectId ?? null,
    ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
    action: "lint_trainer_flags",
  });
  return { ok: true, flagCount: input.document.flags.length };
}

export async function lintResearchIntakeTrainerFlagsFixture(input: {
  repoRoot: string;
  fixtureRelpath: string;
  deviceId?: string;
  subjectId?: string;
  onTelemetry?: (e: ResearchRfcAdoptionTelemetryEvent) => void;
}): Promise<
  | { ok: true; flagCount: number }
  | {
      ok: false;
      failureClass: ResearchRfcAdoptionFailureClass;
      detail: string;
      flagId?: string;
    }
> {
  let raw: string;
  try {
    raw = await readFile(
      path.join(input.repoRoot, input.fixtureRelpath),
      "utf8",
    );
  } catch {
    return {
      ok: false,
      failureClass: "research_rfc.policy_gap",
      detail: `missing fixture ${input.fixtureRelpath}`,
    };
  }
  let document: TrainerFlagsDocument;
  try {
    document = JSON.parse(raw) as TrainerFlagsDocument;
  } catch {
    return {
      ok: false,
      failureClass: "research_rfc.invalid_input",
      detail: "fixture JSON parse failed",
    };
  }
  return lintResearchIntakeTrainerFlags({
    document,
    ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
    ...(input.subjectId !== undefined ? { subjectId: input.subjectId } : {}),
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });
}

export function resetResearchIntakeAdoptionState(): void {
  adoptionReceipts.clear();
}

export type ResearchIntakeAdoptionProof = {
  ok: true;
  docsCoherent: boolean;
  adoptionAccepted: boolean;
  incompleteRejected: boolean;
  silentBypassRejected: boolean;
  greenFlagsOk: boolean;
  orphanFlagsRejected: boolean;
};

/**
 * Prove checklist coherence, adoption gate, and orphan-flag CI fixtures.
 */
export async function proveResearchIntakeAdoptionChecklist(input: {
  repoRoot: string;
  deviceId?: string;
  onTelemetry?: (e: ResearchRfcAdoptionTelemetryEvent) => void;
}): Promise<ResearchIntakeAdoptionProof> {
  resetResearchIntakeAdoptionState();
  const deviceId = input.deviceId ?? "device.research-rfc.adoption";

  const coherent = await assertResearchIntakeAdoptionChecklistCoherent({
    repoRoot: input.repoRoot,
    deviceId,
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });

  const completeSteps = {
    approved: true,
    manifestUpdated: true,
    regenerated: true,
    microRunGreen: true,
    progressUpdated: true,
  } as const;

  const happy = evaluateResearchRfcAdoptionChecklist({
    request: {
      operationId: "op.rfc.adopt.happy",
      rfcId: "RFC-2026-004",
      steps: { ...completeSteps },
      commitCitesRfc: true,
      deviceId,
    },
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });

  const incomplete = evaluateResearchRfcAdoptionChecklist({
    request: {
      operationId: "op.rfc.adopt.partial",
      rfcId: "RFC-2026-004",
      steps: {
        approved: true,
        manifestUpdated: true,
        regenerated: true,
        microRunGreen: false,
        progressUpdated: false,
      },
      commitCitesRfc: true,
      deviceId,
    },
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });

  const silent = evaluateResearchRfcAdoptionChecklist({
    request: {
      operationId: "op.rfc.adopt.silent",
      rfcId: "RFC-2026-004",
      steps: { ...completeSteps },
      commitCitesRfc: true,
      emergencyBypass: true,
      constitutionAmendmentRecordId: null,
      deviceId,
    },
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });

  const green = await lintResearchIntakeTrainerFlagsFixture({
    repoRoot: input.repoRoot,
    fixtureRelpath: RESEARCH_RFC_TRAINER_FLAGS_OK_FIXTURE,
    deviceId,
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });

  const orphan = await lintResearchIntakeTrainerFlagsFixture({
    repoRoot: input.repoRoot,
    fixtureRelpath: RESEARCH_RFC_TRAINER_FLAGS_ORPHAN_FIXTURE,
    deviceId,
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });

  emit(input.onTelemetry, {
    event: "learning.research_intake.rfc",
    outcome: "ok",
    subjectId: null,
    deviceId,
    action: "ci_prove",
  });

  const proof: ResearchIntakeAdoptionProof = {
    ok: true,
    docsCoherent: coherent.ok === true,
    adoptionAccepted: happy.ok === true && happy.idempotentReplay === false,
    incompleteRejected:
      !incomplete.ok &&
      incomplete.failureClass === "research_rfc.adoption_incomplete",
    silentBypassRejected:
      !silent.ok &&
      silent.failureClass === "research_rfc.silent_bypass_forbidden",
    greenFlagsOk: green.ok === true,
    orphanFlagsRejected:
      !orphan.ok &&
      orphan.failureClass === "research_rfc.orphan_trainer_flag",
  };

  if (
    !proof.docsCoherent ||
    !proof.adoptionAccepted ||
    !proof.incompleteRejected ||
    !proof.silentBypassRejected ||
    !proof.greenFlagsOk ||
    !proof.orphanFlagsRejected
  ) {
    throw new ResearchIntakeRfcError(
      "research-intake adoption checklist proof failed",
      { obligation: "research_rfc.policy_gap" },
    );
  }
  return proof;
}
