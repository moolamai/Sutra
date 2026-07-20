/**
 * Append-only checkpoint lineage schema + crash-safe registry (C4).
 *
 * Every training run records corpus/base hashes, hyperparameters, C3 critic
 * versions, SFT|GRPO stage, and an evalVerdicts slot, chained by
 * parentCheckpointHash (omitted only on the genesis SFT anchor). Corrections
 * append a new row with supersededBy — never in-place edits.
 *
 * Persistence: in-memory (tests) or filesystem WAL + atomic rename (`fs`).
 * Recovery promotes a complete `committing` WAL entry or discards `staged` /
 * corrupt partials — never leaves an ambiguous tip.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  TRAJECTORY_HASH_LIMIT,
  TRAJECTORY_ID_LIMIT,
} from "./trajectory_schema.js";

export const CHECKPOINT_LINEAGE_SCHEMA_VERSION =
  "checkpoint.lineage.v1" as const;

export const CHECKPOINT_LINEAGE_SCHEMA_RELPATH =
  "training/pipeline/lineage_schema.json" as const;

/** Soft cap on committed rows returned per list (NFR — bounded scans). */
export const CHECKPOINT_LINEAGE_LIST_LIMIT = 64;

/** Soft cap on hyperparameter keys and critic pins per row. */
export const CHECKPOINT_LINEAGE_HYPERPARAM_KEY_LIMIT = 32;
export const CHECKPOINT_LINEAGE_CRITIC_PIN_LIMIT = 16;
export const CHECKPOINT_LINEAGE_EVAL_VERDICT_LIMIT = 32;

export const CHECKPOINT_LINEAGE_BACKEND_ENV =
  "MOOLAM_CHECKPOINT_LINEAGE_BACKEND" as const;

/** Root directory for the filesystem WAL backend. */
export const CHECKPOINT_LINEAGE_DIR_ENV =
  "MOOLAM_CHECKPOINT_LINEAGE_DIR" as const;

/** Soft cap on durable committed rows per subject (NFR — bounded store). */
export const CHECKPOINT_LINEAGE_STORE_LIMIT = 4096;

export type CheckpointLineageBackendId = "memory" | "fs";

/**
 * Test-only crash injection points for the filesystem WAL writer.
 * Production callers must omit this.
 */
export type CheckpointLineageWalCrashAfter =
  | "after-wal-staged"
  | "after-wal-committing"
  | "after-committed-before-wal-unlink";

export type CheckpointLineageStage = "SFT" | "GRPO";

export type CheckpointLineageLocality = "on-device" | "self-hosted";

export type CheckpointLineageFailureClass =
  | "lineage.validation"
  | "lineage.parent_required"
  | "lineage.parent_forbidden"
  | "lineage.parent_unknown"
  | "lineage.append_only"
  | "lineage.stale_revision"
  | "lineage.subject_scope"
  | "lineage.not_found"
  | "lineage.empty"
  | "lineage.section_limit"
  | "lineage.idempotent_conflict"
  | "lineage.floating_checkpoint"
  | "lineage.backend_unsupported"
  | "lineage.partial_discard"
  | "lineage.wal_corrupt"
  | "lineage.wal_promoted"
  | "lineage.io"
  | "lineage.incomplete"
  | "lineage.missing_critics"
  | "lineage.missing_hyperparameters"
  | "lineage.candidate_denied"
  | "lineage.checkpoint_mismatch";

export type CheckpointLineageTelemetryEvent = {
  event:
    | "learning.lineage.backend"
    | "learning.lineage.append"
    | "learning.lineage.commit"
    | "learning.lineage.recover"
    | "learning.lineage.read"
    | "learning.lineage.lint"
    | "learning.lineage.candidate_admit";
  outcome: "ok" | "fail" | "advisory";
  subjectId: string;
  deviceId: string;
  backend?: CheckpointLineageBackendId;
  runId?: string;
  candidateId?: string;
  stage?: CheckpointLineageStage;
  checkpointHash?: string;
  parentCheckpointHash?: string;
  revision?: number;
  failureClass?: CheckpointLineageFailureClass;
  idempotentReplay?: boolean;
  discardedPending?: boolean;
  promotedPending?: boolean;
  walPhase?: "staged" | "committing";
  complete?: boolean;
};

export class CheckpointLineageContractError extends Error {
  readonly obligation: CheckpointLineageFailureClass;
  readonly subjectId: string | undefined;
  readonly deviceId: string | undefined;
  readonly failingSlice: string | undefined;

  constructor(
    message: string,
    meta: {
      obligation: CheckpointLineageFailureClass;
      subjectId?: string;
      deviceId?: string;
      failingSlice?: string;
    },
  ) {
    super(message);
    this.name = "CheckpointLineageContractError";
    this.obligation = meta.obligation;
    this.subjectId = meta.subjectId;
    this.deviceId = meta.deviceId;
    this.failingSlice = meta.failingSlice;
  }
}

const opaqueHashSchema = z
  .string()
  .min(8)
  .max(TRAJECTORY_HASH_LIMIT)
  .refine((h) => h.toLowerCase() !== "latest", {
    message: "floating checkpoint 'latest' forbidden",
  });

const contentHashSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/, "must be sha256:<64 lowercase hex>");

const criticVersionPinSchema = z
  .object({
    rubricId: z.string().min(1).max(TRAJECTORY_ID_LIMIT),
    rubricVersion: z.string().min(1).max(TRAJECTORY_ID_LIMIT),
    contentHash: contentHashSchema,
  })
  .strict();

const evalVerdictEntrySchema = z
  .object({
    /** Opaque verdict id (suite / slice name) — never raw learner text. */
    verdictId: z.string().min(1).max(TRAJECTORY_ID_LIMIT),
    /** pass | fail | skip | deferred — promotion gates consume later. */
    outcome: z.enum(["pass", "fail", "skip", "deferred"]),
    /** Optional opaque score hash or metric pin. */
    evidenceHash: opaqueHashSchema.optional(),
  })
  .strict();

const hyperparameterValueSchema = z.union([
  z.string().max(256),
  z.number().finite(),
  z.boolean(),
]);

/**
 * Append-only lineage row. Corrections are new rows; use supersededBy on the
 * obsolete runId rather than mutating fields in place.
 */
export const checkpointLineageRowSchema = z
  .object({
    schemaVersion: z.literal(CHECKPOINT_LINEAGE_SCHEMA_VERSION),
    runId: z.string().min(1).max(TRAJECTORY_ID_LIMIT),
    subjectId: z.string().min(1).max(TRAJECTORY_ID_LIMIT),
    deviceId: z.string().min(1).max(TRAJECTORY_ID_LIMIT),
    locality: z.enum(["on-device", "self-hosted"]),
    /** This run's produced checkpoint hash (children point parent here). */
    checkpointHash: opaqueHashSchema,
    /**
     * Parent checkpoint hash. Required on every row except the genesis SFT
     * anchor (first committed SFT for the subject with no prior tip).
     */
    parentCheckpointHash: opaqueHashSchema.optional(),
    corpusManifestHash: contentHashSchema,
    baseModelHash: opaqueHashSchema,
    hyperparameters: z
      .record(z.string().min(1).max(TRAJECTORY_ID_LIMIT), hyperparameterValueSchema)
      .refine(
        (o) => Object.keys(o).length <= CHECKPOINT_LINEAGE_HYPERPARAM_KEY_LIMIT,
        {
          message: `hyperparameters exceed ${CHECKPOINT_LINEAGE_HYPERPARAM_KEY_LIMIT} keys`,
        },
      ),
    criticVersions: z
      .array(criticVersionPinSchema)
      .max(CHECKPOINT_LINEAGE_CRITIC_PIN_LIMIT),
    stage: z.enum(["SFT", "GRPO"]),
    /** Eval verdicts slot — may be empty pending later CI fill. */
    evalVerdicts: z
      .array(evalVerdictEntrySchema)
      .max(CHECKPOINT_LINEAGE_EVAL_VERDICT_LIMIT),
    /** When set, this runId was corrected by the named successor runId. */
    supersededBy: z.string().min(1).max(TRAJECTORY_ID_LIMIT).optional(),
    recordedAt: z.string().min(1).max(TRAJECTORY_HASH_LIMIT),
  })
  .strict();

export type CheckpointLineageRow = z.infer<typeof checkpointLineageRowSchema>;

export type CheckpointLineageCriticPin = z.infer<typeof criticVersionPinSchema>;
export type CheckpointLineageEvalVerdict = z.infer<
  typeof evalVerdictEntrySchema
>;

export type ParseCheckpointLineageOk = {
  ok: true;
  row: CheckpointLineageRow;
};

export type ParseCheckpointLineageFail = {
  ok: false;
  failureClass: CheckpointLineageFailureClass;
  detail: string;
};

export type ParseCheckpointLineageResult =
  | ParseCheckpointLineageOk
  | ParseCheckpointLineageFail;

export type LineageReadFound = {
  kind: "found";
  row: CheckpointLineageRow;
  revision: number;
};

export type LineageReadEmpty = {
  kind: "empty";
  subjectId: string;
};

export type LineageReadNotFound = {
  kind: "not_found";
  subjectId: string;
  runId: string;
};

export type LineageReadResult =
  | LineageReadFound
  | LineageReadEmpty
  | LineageReadNotFound;

export type CheckpointLineageAppendResult = {
  row: CheckpointLineageRow;
  revision: number;
  idempotentReplay: boolean;
  committed: boolean;
};

export type CheckpointLineageRegistry = {
  readonly backendId: CheckpointLineageBackendId;
  /** Monotonic revision for optimistic concurrency (per subject). */
  revision(subjectId: string): number;
  /**
   * Stage a validated row into the pending slot (crash before commit discards).
   * Pass expectedRevision for optimistic concurrency; omit only on first write.
   */
  stageAppend(input: {
    row: unknown;
    expectedRevision?: number;
    onTelemetry?: (e: CheckpointLineageTelemetryEvent) => void;
  }): CheckpointLineageAppendResult;
  /** Promote the pending staged row into the committed append-only log. */
  commitPending(input: {
    subjectId: string;
    deviceId: string;
    onTelemetry?: (e: CheckpointLineageTelemetryEvent) => void;
  }): CheckpointLineageAppendResult;
  /**
   * Atomic stage+commit helper for callers that do not need a kill window.
   */
  appendCommitted(input: {
    row: unknown;
    expectedRevision?: number;
    onTelemetry?: (e: CheckpointLineageTelemetryEvent) => void;
  }): CheckpointLineageAppendResult;
  getByRunId(input: {
    subjectId: string;
    runId: string;
    deviceId?: string;
    onTelemetry?: (e: CheckpointLineageTelemetryEvent) => void;
  }): LineageReadResult;
  listCommitted(input: {
    subjectId: string;
    deviceId?: string;
    limit?: number;
    onTelemetry?: (e: CheckpointLineageTelemetryEvent) => void;
  }): CheckpointLineageRow[];
  /**
   * Discard incomplete pending WAL entry (deterministic recovery rule for
   * this schema slice). Committed history is untouched.
   */
  recover(input: {
    subjectId: string;
    deviceId: string;
    onTelemetry?: (e: CheckpointLineageTelemetryEvent) => void;
  }): { discardedPending: boolean; revision: number };
};

type SubjectSlot = {
  committed: CheckpointLineageRow[];
  byRunId: Map<string, CheckpointLineageRow>;
  tipCheckpointHash: string | undefined;
  revision: number;
  pending: CheckpointLineageRow | undefined;
};

function emit(
  onTelemetry: ((e: CheckpointLineageTelemetryEvent) => void) | undefined,
  event: CheckpointLineageTelemetryEvent,
): void {
  onTelemetry?.(event);
}

function assertOpaqueHash(
  hash: string,
  field: string,
  subjectId?: string,
  deviceId?: string,
): string {
  if (typeof hash !== "string" || hash.length < 8) {
    throw new CheckpointLineageContractError(
      `${field} must be an opaque checkpoint hash`,
      {
        obligation: "lineage.validation",
        ...(subjectId !== undefined ? { subjectId } : {}),
        ...(deviceId !== undefined ? { deviceId } : {}),
        failingSlice: field,
      },
    );
  }
  if (hash.toLowerCase() === "latest") {
    throw new CheckpointLineageContractError(
      `floating checkpoint 'latest' forbidden on ${field}`,
      {
        obligation: "lineage.floating_checkpoint",
        ...(subjectId !== undefined ? { subjectId } : {}),
        ...(deviceId !== undefined ? { deviceId } : {}),
        failingSlice: field,
      },
    );
  }
  if (hash.length > TRAJECTORY_HASH_LIMIT) {
    throw new CheckpointLineageContractError(
      `${field} exceeds hash length limit`,
      {
        obligation: "lineage.section_limit",
        ...(subjectId !== undefined ? { subjectId } : {}),
        ...(deviceId !== undefined ? { deviceId } : {}),
        failingSlice: field,
      },
    );
  }
  return hash;
}

/**
 * Parse + structural validate a lineage row (does not enforce parent-chain
 * registry invariants — those live on append).
 */
export function parseCheckpointLineageRow(
  input: unknown,
): ParseCheckpointLineageResult {
  const parsed = checkpointLineageRowSchema.safeParse(input);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .slice(0, 8)
      .join("; ");
    return {
      ok: false,
      failureClass: "lineage.validation",
      detail: detail || "lineage row failed schema validation",
    };
  }
  return { ok: true, row: parsed.data };
}

/**
 * Parent-hash chain rule: genesis SFT may omit parent; every other row must
 * include parentCheckpointHash.
 */
export function assertParentHashChainRule(
  row: CheckpointLineageRow,
  opts: { isGenesis: boolean },
): void {
  if (opts.isGenesis) {
    if (row.stage !== "SFT") {
      throw new CheckpointLineageContractError(
        "genesis lineage row must be stage SFT",
        {
          obligation: "lineage.parent_forbidden",
          subjectId: row.subjectId,
          deviceId: row.deviceId,
          failingSlice: row.runId,
        },
      );
    }
    if (row.parentCheckpointHash !== undefined) {
      throw new CheckpointLineageContractError(
        "genesis SFT anchor must not carry parentCheckpointHash",
        {
          obligation: "lineage.parent_forbidden",
          subjectId: row.subjectId,
          deviceId: row.deviceId,
          failingSlice: row.runId,
        },
      );
    }
    return;
  }
  if (row.parentCheckpointHash === undefined) {
    throw new CheckpointLineageContractError(
      "non-genesis lineage row requires parentCheckpointHash",
      {
        obligation: "lineage.parent_required",
        subjectId: row.subjectId,
        deviceId: row.deviceId,
        failingSlice: row.runId,
      },
    );
  }
  assertOpaqueHash(
    row.parentCheckpointHash,
    "parentCheckpointHash",
    row.subjectId,
    row.deviceId,
  );
}

let backendLogged = false;

export function resolveCheckpointLineageBackend(
  env: NodeJS.ProcessEnv = process.env,
): CheckpointLineageBackendId {
  const raw = env[CHECKPOINT_LINEAGE_BACKEND_ENV]?.trim().toLowerCase();
  if (raw === undefined || raw === "" || raw === "memory") {
    return "memory";
  }
  if (raw === "fs" || raw === "file" || raw === "wal") {
    return "fs";
  }
  throw new CheckpointLineageContractError(
    `unsupported lineage backend '${raw}' (supported: memory, fs)`,
    {
      obligation: "lineage.backend_unsupported",
      failingSlice: raw,
    },
  );
}

export function openCheckpointLineageRegistry(opts?: {
  backend?: CheckpointLineageBackendId;
  env?: NodeJS.ProcessEnv;
  rootDir?: string;
  /** Test-only crash injection for the fs WAL writer. */
  crashAfter?: CheckpointLineageWalCrashAfter;
  onTelemetry?: (e: CheckpointLineageTelemetryEvent) => void;
}): CheckpointLineageRegistry {
  const env = opts?.env ?? process.env;
  const backend = opts?.backend ?? resolveCheckpointLineageBackend(env);
  if (!backendLogged) {
    backendLogged = true;
    emit(opts?.onTelemetry, {
      event: "learning.lineage.backend",
      outcome: "ok",
      subjectId: "lineage",
      deviceId: "startup",
      backend,
    });
  }
  if (backend === "memory") {
    return new InMemoryCheckpointLineageRegistry();
  }
  if (backend === "fs") {
    const rootDir =
      opts?.rootDir ?? env[CHECKPOINT_LINEAGE_DIR_ENV]?.trim() ?? "";
    if (!rootDir) {
      throw new CheckpointLineageContractError(
        `fs lineage backend requires rootDir or ${CHECKPOINT_LINEAGE_DIR_ENV}`,
        {
          obligation: "lineage.backend_unsupported",
          failingSlice: CHECKPOINT_LINEAGE_DIR_ENV,
        },
      );
    }
    return new FileWalCheckpointLineageRegistry({
      rootDir,
      ...(opts?.crashAfter !== undefined
        ? { crashAfter: opts.crashAfter }
        : {}),
      ...(opts?.onTelemetry !== undefined
        ? { onTelemetry: opts.onTelemetry }
        : {}),
    });
  }
  throw new CheckpointLineageContractError(
    `unsupported lineage backend '${backend as string}'`,
    {
      obligation: "lineage.backend_unsupported",
      failingSlice: String(backend),
    },
  );
}

/** Test helper — allow re-logging backend on next open. */
export function resetCheckpointLineageBackendLog(): void {
  backendLogged = false;
}

export class InMemoryCheckpointLineageRegistry
  implements CheckpointLineageRegistry
{
  readonly backendId: CheckpointLineageBackendId = "memory";
  protected readonly subjects = new Map<string, SubjectSlot>();

  revision(subjectId: string): number {
    return this.ensureSlot(subjectId).revision;
  }

  stageAppend(input: {
    row: unknown;
    expectedRevision?: number;
    onTelemetry?: (e: CheckpointLineageTelemetryEvent) => void;
  }): CheckpointLineageAppendResult {
    const parsed = parseCheckpointLineageRow(input.row);
    if (!parsed.ok) {
      emit(input.onTelemetry, {
        event: "learning.lineage.append",
        outcome: "fail",
        subjectId: "unknown",
        deviceId: "unknown",
        failureClass: parsed.failureClass,
      });
      throw new CheckpointLineageContractError(parsed.detail, {
        obligation: parsed.failureClass,
      });
    }
    const row = parsed.row;
    const slot = this.ensureSlot(row.subjectId);
    this.assertDiskRevisionFresh(row.subjectId, slot);

    if (slot.pending !== undefined) {
      emit(input.onTelemetry, {
        event: "learning.lineage.append",
        outcome: "fail",
        subjectId: row.subjectId,
        deviceId: row.deviceId,
        runId: row.runId,
        failureClass: "lineage.append_only",
      });
      throw new CheckpointLineageContractError(
        "pending lineage WAL entry exists — commit or recover before staging another row",
        {
          obligation: "lineage.append_only",
          subjectId: row.subjectId,
          deviceId: row.deviceId,
          failingSlice: row.runId,
        },
      );
    }

    if (input.expectedRevision !== undefined) {
      if (input.expectedRevision !== slot.revision) {
        emit(input.onTelemetry, {
          event: "learning.lineage.append",
          outcome: "fail",
          subjectId: row.subjectId,
          deviceId: row.deviceId,
          runId: row.runId,
          revision: slot.revision,
          failureClass: "lineage.stale_revision",
        });
        throw new CheckpointLineageContractError(
          "stale lineage revision — optimistic concurrency rejected write",
          {
            obligation: "lineage.stale_revision",
            subjectId: row.subjectId,
            deviceId: row.deviceId,
            failingSlice: row.runId,
          },
        );
      }
    } else if (slot.revision !== 0) {
      emit(input.onTelemetry, {
        event: "learning.lineage.append",
        outcome: "fail",
        subjectId: row.subjectId,
        deviceId: row.deviceId,
        runId: row.runId,
        revision: slot.revision,
        failureClass: "lineage.stale_revision",
      });
      throw new CheckpointLineageContractError(
        "expectedRevision required after genesis — stale write rejected",
        {
          obligation: "lineage.stale_revision",
          subjectId: row.subjectId,
          deviceId: row.deviceId,
          failingSlice: row.runId,
        },
      );
    }

    const existing = slot.byRunId.get(row.runId);
    if (existing) {
      if (rowsEquivalent(existing, row)) {
        emit(input.onTelemetry, {
          event: "learning.lineage.append",
          outcome: "ok",
          subjectId: row.subjectId,
          deviceId: row.deviceId,
          runId: row.runId,
          stage: row.stage,
          checkpointHash: row.checkpointHash,
          ...(row.parentCheckpointHash !== undefined
            ? { parentCheckpointHash: row.parentCheckpointHash }
            : {}),
          revision: slot.revision,
          idempotentReplay: true,
        });
        return {
          row: existing,
          revision: slot.revision,
          idempotentReplay: true,
          committed: true,
        };
      }
      emit(input.onTelemetry, {
        event: "learning.lineage.append",
        outcome: "fail",
        subjectId: row.subjectId,
        deviceId: row.deviceId,
        runId: row.runId,
        failureClass: "lineage.idempotent_conflict",
      });
      throw new CheckpointLineageContractError(
        "runId already committed with different lineage payload",
        {
          obligation: "lineage.idempotent_conflict",
          subjectId: row.subjectId,
          deviceId: row.deviceId,
          failingSlice: row.runId,
        },
      );
    }

    const isGenesis = slot.committed.length === 0;
    assertParentHashChainRule(row, { isGenesis });

    if (!isGenesis) {
      const parent = row.parentCheckpointHash!;
      if (parent !== slot.tipCheckpointHash) {
        const known = [...slot.byRunId.values()].some(
          (r) => r.checkpointHash === parent,
        );
        emit(input.onTelemetry, {
          event: "learning.lineage.append",
          outcome: "fail",
          subjectId: row.subjectId,
          deviceId: row.deviceId,
          runId: row.runId,
          parentCheckpointHash: parent,
          failureClass: known
            ? "lineage.append_only"
            : "lineage.parent_unknown",
        });
        throw new CheckpointLineageContractError(
          known
            ? "parentCheckpointHash must equal the current tip — lineage is append-only"
            : "parentCheckpointHash does not resolve to a committed checkpoint",
          {
            obligation: known
              ? "lineage.append_only"
              : "lineage.parent_unknown",
            subjectId: row.subjectId,
            deviceId: row.deviceId,
            failingSlice: row.runId,
          },
        );
      }
    }

    if (slot.committed.length >= CHECKPOINT_LINEAGE_STORE_LIMIT) {
      throw new CheckpointLineageContractError(
        `committed lineage exceeds store limit ${CHECKPOINT_LINEAGE_STORE_LIMIT}`,
        {
          obligation: "lineage.section_limit",
          subjectId: row.subjectId,
          deviceId: row.deviceId,
          failingSlice: row.runId,
        },
      );
    }

    const staged: CheckpointLineageRow = structuredClone(row);
    slot.pending = staged;
    this.persistWalStaged(row.subjectId, staged, slot.revision);

    emit(input.onTelemetry, {
      event: "learning.lineage.append",
      outcome: "ok",
      subjectId: row.subjectId,
      deviceId: row.deviceId,
      runId: row.runId,
      stage: row.stage,
      checkpointHash: row.checkpointHash,
      ...(row.parentCheckpointHash !== undefined
        ? { parentCheckpointHash: row.parentCheckpointHash }
        : {}),
      revision: slot.revision,
      walPhase: "staged",
    });

    return {
      row: staged,
      revision: slot.revision,
      idempotentReplay: false,
      committed: false,
    };
  }

  commitPending(input: {
    subjectId: string;
    deviceId: string;
    onTelemetry?: (e: CheckpointLineageTelemetryEvent) => void;
  }): CheckpointLineageAppendResult {
    const slot = this.ensureSlot(input.subjectId);
    if (!slot.pending) {
      emit(input.onTelemetry, {
        event: "learning.lineage.commit",
        outcome: "fail",
        subjectId: input.subjectId,
        deviceId: input.deviceId,
        failureClass: "lineage.not_found",
      });
      throw new CheckpointLineageContractError(
        "no pending lineage row to commit",
        {
          obligation: "lineage.not_found",
          subjectId: input.subjectId,
          deviceId: input.deviceId,
        },
      );
    }

    const row = slot.pending;
    if (row.subjectId !== input.subjectId) {
      emit(input.onTelemetry, {
        event: "learning.lineage.commit",
        outcome: "fail",
        subjectId: input.subjectId,
        deviceId: input.deviceId,
        runId: row.runId,
        failureClass: "lineage.subject_scope",
      });
      throw new CheckpointLineageContractError(
        "pending lineage row subjectId does not match commit scope",
        {
          obligation: "lineage.subject_scope",
          subjectId: input.subjectId,
          deviceId: input.deviceId,
          failingSlice: row.runId,
        },
      );
    }

    this.assertDiskRevisionFresh(input.subjectId, slot);
    this.persistWalCommitting(input.subjectId, row, slot.revision);

    slot.pending = undefined;
    slot.committed.push(row);
    slot.byRunId.set(row.runId, row);
    slot.tipCheckpointHash = row.checkpointHash;
    slot.revision += 1;

    this.persistCommitted(input.subjectId, slot);
    this.clearWal(input.subjectId);

    emit(input.onTelemetry, {
      event: "learning.lineage.commit",
      outcome: "ok",
      subjectId: row.subjectId,
      deviceId: input.deviceId,
      runId: row.runId,
      stage: row.stage,
      checkpointHash: row.checkpointHash,
      ...(row.parentCheckpointHash !== undefined
        ? { parentCheckpointHash: row.parentCheckpointHash }
        : {}),
      revision: slot.revision,
      walPhase: "committing",
    });

    return {
      row,
      revision: slot.revision,
      idempotentReplay: false,
      committed: true,
    };
  }

  appendCommitted(input: {
    row: unknown;
    expectedRevision?: number;
    onTelemetry?: (e: CheckpointLineageTelemetryEvent) => void;
  }): CheckpointLineageAppendResult {
    const staged = this.stageAppend(input);
    if (staged.idempotentReplay && staged.committed) {
      return staged;
    }
    const row = staged.row;
    return this.commitPending({
      subjectId: row.subjectId,
      deviceId: row.deviceId,
      ...(input.onTelemetry !== undefined
        ? { onTelemetry: input.onTelemetry }
        : {}),
    });
  }

  getByRunId(input: {
    subjectId: string;
    runId: string;
    deviceId?: string;
    onTelemetry?: (e: CheckpointLineageTelemetryEvent) => void;
  }): LineageReadResult {
    const deviceId = input.deviceId ?? "ci";
    const slot = this.ensureSlot(input.subjectId);
    if (slot.committed.length === 0) {
      emit(input.onTelemetry, {
        event: "learning.lineage.read",
        outcome: "advisory",
        subjectId: input.subjectId,
        deviceId,
        runId: input.runId,
        failureClass: "lineage.empty",
      });
      return { kind: "empty", subjectId: input.subjectId };
    }
    const row = slot.byRunId.get(input.runId);
    if (!row) {
      emit(input.onTelemetry, {
        event: "learning.lineage.read",
        outcome: "fail",
        subjectId: input.subjectId,
        deviceId,
        runId: input.runId,
        failureClass: "lineage.not_found",
      });
      return {
        kind: "not_found",
        subjectId: input.subjectId,
        runId: input.runId,
      };
    }
    if (row.subjectId !== input.subjectId) {
      emit(input.onTelemetry, {
        event: "learning.lineage.read",
        outcome: "fail",
        subjectId: input.subjectId,
        deviceId,
        runId: input.runId,
        failureClass: "lineage.subject_scope",
      });
      throw new CheckpointLineageContractError(
        "cross-subject lineage read denied",
        {
          obligation: "lineage.subject_scope",
          subjectId: input.subjectId,
          deviceId,
          failingSlice: input.runId,
        },
      );
    }
    emit(input.onTelemetry, {
      event: "learning.lineage.read",
      outcome: "ok",
      subjectId: input.subjectId,
      deviceId,
      runId: input.runId,
      stage: row.stage,
      checkpointHash: row.checkpointHash,
      revision: slot.revision,
    });
    return { kind: "found", row, revision: slot.revision };
  }

  listCommitted(input: {
    subjectId: string;
    deviceId?: string;
    limit?: number;
    onTelemetry?: (e: CheckpointLineageTelemetryEvent) => void;
  }): CheckpointLineageRow[] {
    const deviceId = input.deviceId ?? "ci";
    const limit = Math.min(
      input.limit ?? CHECKPOINT_LINEAGE_LIST_LIMIT,
      CHECKPOINT_LINEAGE_LIST_LIMIT,
    );
    if (limit < 1) {
      throw new CheckpointLineageContractError("list limit must be ≥ 1", {
        obligation: "lineage.section_limit",
        subjectId: input.subjectId,
        deviceId,
      });
    }
    const slot = this.ensureSlot(input.subjectId);
    if (slot.committed.length === 0) {
      emit(input.onTelemetry, {
        event: "learning.lineage.read",
        outcome: "advisory",
        subjectId: input.subjectId,
        deviceId,
        failureClass: "lineage.empty",
      });
      return [];
    }
    const rows = slot.committed.slice(-limit);
    emit(input.onTelemetry, {
      event: "learning.lineage.read",
      outcome: "ok",
      subjectId: input.subjectId,
      deviceId,
      revision: slot.revision,
    });
    return rows.map((r) => ({ ...r }));
  }

  recover(input: {
    subjectId: string;
    deviceId: string;
    onTelemetry?: (e: CheckpointLineageTelemetryEvent) => void;
  }): { discardedPending: boolean; revision: number } {
    const slot = this.ensureSlot(input.subjectId);
    const recovered = this.recoverDurable(input.subjectId, input.deviceId, input.onTelemetry);
    if (recovered !== undefined) {
      return recovered;
    }
    const discarded = slot.pending !== undefined;
    if (discarded) {
      slot.pending = undefined;
      this.clearWal(input.subjectId);
    }
    emit(input.onTelemetry, {
      event: "learning.lineage.recover",
      outcome: discarded ? "advisory" : "ok",
      subjectId: input.subjectId,
      deviceId: input.deviceId,
      discardedPending: discarded,
      revision: slot.revision,
      ...(discarded ? { failureClass: "lineage.partial_discard" as const } : {}),
    });
    return { discardedPending: discarded, revision: slot.revision };
  }

  /**
   * Simulate process kill + restart: drop pending, keep committed (in-memory
   * "durable" log). Returns a fresh registry view of the same committed rows.
   */
  simulateRestart(): InMemoryCheckpointLineageRegistry {
    const next = new InMemoryCheckpointLineageRegistry();
    for (const [subjectId, slot] of this.subjects) {
      const cloned: SubjectSlot = {
        committed: slot.committed.map((r) => ({ ...r })),
        byRunId: new Map(),
        tipCheckpointHash: slot.tipCheckpointHash,
        revision: slot.revision,
        pending: undefined,
      };
      for (const row of cloned.committed) {
        cloned.byRunId.set(row.runId, row);
      }
      next.subjects.set(subjectId, cloned);
    }
    return next;
  }

  protected ensureSlot(subjectId: string): SubjectSlot {
    let slot = this.subjects.get(subjectId);
    if (!slot) {
      slot = this.loadDurableSlot(subjectId) ?? {
        committed: [],
        byRunId: new Map(),
        tipCheckpointHash: undefined,
        revision: 0,
        pending: undefined,
      };
      this.subjects.set(subjectId, slot);
    }
    return slot;
  }

  /** Cross-process OCC: no-op for memory; fs re-reads meta.json. */
  protected assertDiskRevisionFresh(
    _subjectId: string,
    _slot: SubjectSlot,
  ): void {}

  protected persistWalStaged(
    _subjectId: string,
    _row: CheckpointLineageRow,
    _baseRevision: number,
  ): void {}

  protected persistWalCommitting(
    _subjectId: string,
    _row: CheckpointLineageRow,
    _baseRevision: number,
  ): void {}

  protected persistCommitted(_subjectId: string, _slot: SubjectSlot): void {}

  protected clearWal(_subjectId: string): void {}

  protected loadDurableSlot(_subjectId: string): SubjectSlot | undefined {
    return undefined;
  }

  protected recoverDurable(
    _subjectId: string,
    _deviceId: string,
    _onTelemetry?: (e: CheckpointLineageTelemetryEvent) => void,
  ): { discardedPending: boolean; revision: number } | undefined {
    return undefined;
  }
}

function rowsEquivalent(
  a: CheckpointLineageRow,
  b: CheckpointLineageRow,
): boolean {
  return (
    a.schemaVersion === b.schemaVersion &&
    a.runId === b.runId &&
    a.subjectId === b.subjectId &&
    a.deviceId === b.deviceId &&
    a.locality === b.locality &&
    a.checkpointHash === b.checkpointHash &&
    a.parentCheckpointHash === b.parentCheckpointHash &&
    a.corpusManifestHash === b.corpusManifestHash &&
    a.baseModelHash === b.baseModelHash &&
    a.stage === b.stage &&
    a.recordedAt === b.recordedAt &&
    a.supersededBy === b.supersededBy &&
    JSON.stringify(a.hyperparameters) === JSON.stringify(b.hyperparameters) &&
    JSON.stringify(a.criticVersions) === JSON.stringify(b.criticVersions) &&
    JSON.stringify(a.evalVerdicts) === JSON.stringify(b.evalVerdicts)
  );
}

const LINEAGE_WAL_SCHEMA_VERSION = "checkpoint.lineage.wal.v1" as const;
const LINEAGE_META_SCHEMA_VERSION = "checkpoint.lineage.meta.v1" as const;

type LineageWalPhase = "staged" | "committing";

type LineageWalRecord = {
  schemaVersion: typeof LINEAGE_WAL_SCHEMA_VERSION;
  phase: LineageWalPhase;
  baseRevision: number;
  row: CheckpointLineageRow;
};

type LineageMetaRecord = {
  schemaVersion: typeof LINEAGE_META_SCHEMA_VERSION;
  subjectId: string;
  revision: number;
  tipCheckpointHash: string | null;
};

type LineageCommittedRecord = {
  schemaVersion: typeof CHECKPOINT_LINEAGE_SCHEMA_VERSION;
  subjectId: string;
  rows: CheckpointLineageRow[];
};

function safeSubjectDirName(subjectId: string): string {
  return subjectId.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, TRAJECTORY_ID_LIMIT);
}

function atomicWriteJson(abs: string, value: unknown): void {
  mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value)}\n`, "utf8");
    renameSync(tmp, abs);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* best-effort tmp cleanup */
    }
    throw new CheckpointLineageContractError(
      `lineage durable write failed: ${err instanceof Error ? err.message : String(err)}`,
      { obligation: "lineage.io", failingSlice: abs },
    );
  }
}

function unlinkQuiet(abs: string): void {
  try {
    if (existsSync(abs)) unlinkSync(abs);
  } catch {
    /* ignore */
  }
}

function scrubTmpFiles(dir: string): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name.includes(".tmp-")) {
      unlinkQuiet(path.join(dir, name));
    }
  }
}

/**
 * Filesystem WAL + atomic rename lineage registry.
 *
 * Layout per subject: `<root>/<subject>/meta.json`, `committed.json`, `wal.json`.
 *
 * Recovery rules (deterministic):
 * - corrupt / incomplete WAL or leftover `*.tmp-*` → discard
 * - `phase: staged` → discard (crash before commit started)
 * - `phase: committing` and runId already in committed → discard WAL
 * - `phase: committing` and runId missing → promote into committed, then clear WAL
 */
export class FileWalCheckpointLineageRegistry extends InMemoryCheckpointLineageRegistry {
  override readonly backendId: CheckpointLineageBackendId = "fs";
  private readonly rootDir: string;
  private readonly crashAfter: CheckpointLineageWalCrashAfter | undefined;
  private readonly openTelemetry:
    | ((e: CheckpointLineageTelemetryEvent) => void)
    | undefined;

  constructor(opts: {
    rootDir: string;
    crashAfter?: CheckpointLineageWalCrashAfter;
    onTelemetry?: (e: CheckpointLineageTelemetryEvent) => void;
  }) {
    super();
    this.rootDir = path.resolve(opts.rootDir);
    this.crashAfter = opts.crashAfter;
    this.openTelemetry = opts.onTelemetry;
    mkdirSync(this.rootDir, { recursive: true });
  }

  subjectDir(subjectId: string): string {
    return path.join(this.rootDir, safeSubjectDirName(subjectId));
  }

  /** Re-open the same root — applies WAL recovery per accessed subject. */
  reopen(): FileWalCheckpointLineageRegistry {
    return new FileWalCheckpointLineageRegistry({
      rootDir: this.rootDir,
      ...(this.openTelemetry !== undefined
        ? { onTelemetry: this.openTelemetry }
        : {}),
    });
  }

  protected override assertDiskRevisionFresh(
    subjectId: string,
    slot: SubjectSlot,
  ): void {
    const meta = this.readMeta(subjectId);
    if (meta !== undefined && meta.revision !== slot.revision) {
      throw new CheckpointLineageContractError(
        "stale lineage revision on disk — concurrent writer won; reject write",
        {
          obligation: "lineage.stale_revision",
          subjectId,
          failingSlice: String(meta.revision),
        },
      );
    }
  }

  protected override persistWalStaged(
    subjectId: string,
    row: CheckpointLineageRow,
    baseRevision: number,
  ): void {
    const record: LineageWalRecord = {
      schemaVersion: LINEAGE_WAL_SCHEMA_VERSION,
      phase: "staged",
      baseRevision,
      row,
    };
    atomicWriteJson(this.walPath(subjectId), record);
    if (this.crashAfter === "after-wal-staged") {
      throw new CheckpointLineageContractError(
        "injected crash after WAL staged",
        {
          obligation: "lineage.io",
          subjectId,
          deviceId: row.deviceId,
          failingSlice: row.runId,
        },
      );
    }
  }

  protected override persistWalCommitting(
    subjectId: string,
    row: CheckpointLineageRow,
    baseRevision: number,
  ): void {
    const record: LineageWalRecord = {
      schemaVersion: LINEAGE_WAL_SCHEMA_VERSION,
      phase: "committing",
      baseRevision,
      row,
    };
    atomicWriteJson(this.walPath(subjectId), record);
    if (this.crashAfter === "after-wal-committing") {
      throw new CheckpointLineageContractError(
        "injected crash after WAL committing marker",
        {
          obligation: "lineage.io",
          subjectId,
          deviceId: row.deviceId,
          failingSlice: row.runId,
        },
      );
    }
  }

  protected override persistCommitted(
    subjectId: string,
    slot: SubjectSlot,
  ): void {
    if (slot.committed.length > CHECKPOINT_LINEAGE_STORE_LIMIT) {
      throw new CheckpointLineageContractError(
        `committed lineage exceeds store limit ${CHECKPOINT_LINEAGE_STORE_LIMIT}`,
        {
          obligation: "lineage.section_limit",
          subjectId,
        },
      );
    }
    const committed: LineageCommittedRecord = {
      schemaVersion: CHECKPOINT_LINEAGE_SCHEMA_VERSION,
      subjectId,
      rows: slot.committed.map((r) => structuredClone(r)),
    };
    const meta: LineageMetaRecord = {
      schemaVersion: LINEAGE_META_SCHEMA_VERSION,
      subjectId,
      revision: slot.revision,
      tipCheckpointHash: slot.tipCheckpointHash ?? null,
    };
    atomicWriteJson(this.committedPath(subjectId), committed);
    atomicWriteJson(this.metaPath(subjectId), meta);
    if (this.crashAfter === "after-committed-before-wal-unlink") {
      throw new CheckpointLineageContractError(
        "injected crash after committed durable write, before WAL unlink",
        {
          obligation: "lineage.io",
          subjectId,
        },
      );
    }
  }

  protected override clearWal(subjectId: string): void {
    unlinkQuiet(this.walPath(subjectId));
    scrubTmpFiles(this.subjectDir(subjectId));
  }

  protected override loadDurableSlot(
    subjectId: string,
  ): SubjectSlot | undefined {
    const dir = this.subjectDir(subjectId);
    scrubTmpFiles(dir);
    const meta = this.readMeta(subjectId);
    const committedDoc = this.readCommitted(subjectId);
    if (!meta && !committedDoc && !existsSync(this.walPath(subjectId))) {
      return undefined;
    }

    const slot: SubjectSlot = {
      committed: [],
      byRunId: new Map(),
      tipCheckpointHash: meta?.tipCheckpointHash ?? undefined,
      revision: meta?.revision ?? 0,
      pending: undefined,
    };

    if (committedDoc) {
      if (committedDoc.subjectId !== subjectId) {
        throw new CheckpointLineageContractError(
          "committed lineage subjectId mismatch on disk",
          {
            obligation: "lineage.subject_scope",
            subjectId,
            failingSlice: committedDoc.subjectId,
          },
        );
      }
      for (const row of committedDoc.rows) {
        if (row.subjectId !== subjectId) {
          throw new CheckpointLineageContractError(
            "cross-subject row in committed lineage file",
            {
              obligation: "lineage.subject_scope",
              subjectId,
              failingSlice: row.runId,
            },
          );
        }
        const parsed = parseCheckpointLineageRow(row);
        if (!parsed.ok) {
          throw new CheckpointLineageContractError(parsed.detail, {
            obligation: "lineage.wal_corrupt",
            subjectId,
            failingSlice: row.runId,
          });
        }
        slot.committed.push(parsed.row);
        slot.byRunId.set(parsed.row.runId, parsed.row);
      }
      if (slot.committed.length > 0) {
        slot.tipCheckpointHash =
          slot.committed[slot.committed.length - 1]!.checkpointHash;
      }
      if (meta === undefined) {
        slot.revision = slot.committed.length;
      }
    }

    // Apply WAL recovery into the loaded slot (may promote or discard).
    this.applyWalRecovery(subjectId, slot, "startup", this.openTelemetry);
    return slot;
  }

  protected override recoverDurable(
    subjectId: string,
    deviceId: string,
    onTelemetry?: (e: CheckpointLineageTelemetryEvent) => void,
  ): { discardedPending: boolean; revision: number } {
    const slot = this.ensureSlot(subjectId);
    return this.applyWalRecovery(subjectId, slot, deviceId, onTelemetry);
  }

  private applyWalRecovery(
    subjectId: string,
    slot: SubjectSlot,
    deviceId: string,
    onTelemetry?: (e: CheckpointLineageTelemetryEvent) => void,
  ): { discardedPending: boolean; revision: number } {
    scrubTmpFiles(this.subjectDir(subjectId));
    const walPath = this.walPath(subjectId);
    if (!existsSync(walPath)) {
      slot.pending = undefined;
      emit(onTelemetry, {
        event: "learning.lineage.recover",
        outcome: "ok",
        subjectId,
        deviceId,
        discardedPending: false,
        revision: slot.revision,
        backend: "fs",
      });
      return { discardedPending: false, revision: slot.revision };
    }

    let wal: LineageWalRecord | undefined;
    try {
      wal = JSON.parse(readFileSync(walPath, "utf8")) as LineageWalRecord;
    } catch {
      unlinkQuiet(walPath);
      slot.pending = undefined;
      emit(onTelemetry, {
        event: "learning.lineage.recover",
        outcome: "advisory",
        subjectId,
        deviceId,
        discardedPending: true,
        revision: slot.revision,
        failureClass: "lineage.wal_corrupt",
        backend: "fs",
      });
      return { discardedPending: true, revision: slot.revision };
    }

    if (
      wal.schemaVersion !== LINEAGE_WAL_SCHEMA_VERSION ||
      (wal.phase !== "staged" && wal.phase !== "committing") ||
      typeof wal.baseRevision !== "number"
    ) {
      unlinkQuiet(walPath);
      slot.pending = undefined;
      emit(onTelemetry, {
        event: "learning.lineage.recover",
        outcome: "advisory",
        subjectId,
        deviceId,
        discardedPending: true,
        revision: slot.revision,
        failureClass: "lineage.wal_corrupt",
        backend: "fs",
      });
      return { discardedPending: true, revision: slot.revision };
    }

    const parsed = parseCheckpointLineageRow(wal.row);
    if (!parsed.ok || parsed.row.subjectId !== subjectId) {
      unlinkQuiet(walPath);
      slot.pending = undefined;
      emit(onTelemetry, {
        event: "learning.lineage.recover",
        outcome: "advisory",
        subjectId,
        deviceId,
        discardedPending: true,
        revision: slot.revision,
        failureClass:
          parsed.ok === false
            ? "lineage.wal_corrupt"
            : "lineage.subject_scope",
        backend: "fs",
      });
      return { discardedPending: true, revision: slot.revision };
    }

    const row = parsed.row;

    if (wal.phase === "staged") {
      unlinkQuiet(walPath);
      slot.pending = undefined;
      emit(onTelemetry, {
        event: "learning.lineage.recover",
        outcome: "advisory",
        subjectId,
        deviceId,
        runId: row.runId,
        discardedPending: true,
        revision: slot.revision,
        failureClass: "lineage.partial_discard",
        walPhase: "staged",
        backend: "fs",
      });
      return { discardedPending: true, revision: slot.revision };
    }

    // phase === committing
    if (slot.byRunId.has(row.runId)) {
      unlinkQuiet(walPath);
      slot.pending = undefined;
      emit(onTelemetry, {
        event: "learning.lineage.recover",
        outcome: "ok",
        subjectId,
        deviceId,
        runId: row.runId,
        discardedPending: true,
        revision: slot.revision,
        walPhase: "committing",
        backend: "fs",
      });
      return { discardedPending: true, revision: slot.revision };
    }

    // Promote: durable commit was interrupted after WAL marker.
    assertParentHashChainRule(row, {
      isGenesis: slot.committed.length === 0,
    });
    if (
      slot.committed.length > 0 &&
      row.parentCheckpointHash !== slot.tipCheckpointHash
    ) {
      unlinkQuiet(walPath);
      slot.pending = undefined;
      emit(onTelemetry, {
        event: "learning.lineage.recover",
        outcome: "advisory",
        subjectId,
        deviceId,
        runId: row.runId,
        discardedPending: true,
        revision: slot.revision,
        failureClass: "lineage.wal_corrupt",
        walPhase: "committing",
        backend: "fs",
      });
      return { discardedPending: true, revision: slot.revision };
    }

    slot.committed.push(row);
    slot.byRunId.set(row.runId, row);
    slot.tipCheckpointHash = row.checkpointHash;
    slot.revision = Math.max(slot.revision, wal.baseRevision) + 1;
    slot.pending = undefined;
    this.persistCommitted(subjectId, slot);
    unlinkQuiet(walPath);

    emit(onTelemetry, {
      event: "learning.lineage.recover",
      outcome: "ok",
      subjectId,
      deviceId,
      runId: row.runId,
      discardedPending: false,
      promotedPending: true,
      revision: slot.revision,
      failureClass: "lineage.wal_promoted",
      walPhase: "committing",
      checkpointHash: row.checkpointHash,
      backend: "fs",
    });
    return { discardedPending: false, revision: slot.revision };
  }

  private metaPath(subjectId: string): string {
    return path.join(this.subjectDir(subjectId), "meta.json");
  }

  private committedPath(subjectId: string): string {
    return path.join(this.subjectDir(subjectId), "committed.json");
  }

  private walPath(subjectId: string): string {
    return path.join(this.subjectDir(subjectId), "wal.json");
  }

  private readMeta(subjectId: string): LineageMetaRecord | undefined {
    const p = this.metaPath(subjectId);
    if (!existsSync(p)) return undefined;
    try {
      const doc = JSON.parse(readFileSync(p, "utf8")) as LineageMetaRecord;
      if (doc.schemaVersion !== LINEAGE_META_SCHEMA_VERSION) return undefined;
      if (doc.subjectId !== subjectId) {
        throw new CheckpointLineageContractError(
          "meta subjectId mismatch on disk",
          {
            obligation: "lineage.subject_scope",
            subjectId,
            failingSlice: doc.subjectId,
          },
        );
      }
      return doc;
    } catch (err) {
      if (err instanceof CheckpointLineageContractError) throw err;
      return undefined;
    }
  }

  private readCommitted(
    subjectId: string,
  ): LineageCommittedRecord | undefined {
    const p = this.committedPath(subjectId);
    if (!existsSync(p)) return undefined;
    try {
      return JSON.parse(readFileSync(p, "utf8")) as LineageCommittedRecord;
    } catch {
      throw new CheckpointLineageContractError(
        "committed lineage file is corrupt",
        {
          obligation: "lineage.wal_corrupt",
          subjectId,
        },
      );
    }
  }
}

/** Stable JSON Schema document matching checkpointLineageRowSchema. */
export function checkpointLineageJsonSchema(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://moolam.ai/schemas/checkpoint.lineage.v1.json",
    title: "Checkpoint lineage row v1",
    description:
      "Append-only training checkpoint lineage: parent-hash chain, corpus/base pins, hyperparameters, C3 critic versions, SFT|GRPO stage, evalVerdicts slot. Corrections append with supersededBy.",
    schemaVersion: CHECKPOINT_LINEAGE_SCHEMA_VERSION,
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "runId",
      "subjectId",
      "deviceId",
      "locality",
      "checkpointHash",
      "corpusManifestHash",
      "baseModelHash",
      "hyperparameters",
      "criticVersions",
      "stage",
      "evalVerdicts",
      "recordedAt",
    ],
    properties: {
      schemaVersion: {
        type: "string",
        const: CHECKPOINT_LINEAGE_SCHEMA_VERSION,
      },
      runId: { type: "string", minLength: 1, maxLength: TRAJECTORY_ID_LIMIT },
      subjectId: {
        type: "string",
        minLength: 1,
        maxLength: TRAJECTORY_ID_LIMIT,
      },
      deviceId: {
        type: "string",
        minLength: 1,
        maxLength: TRAJECTORY_ID_LIMIT,
      },
      locality: { type: "string", enum: ["on-device", "self-hosted"] },
      checkpointHash: {
        type: "string",
        minLength: 8,
        maxLength: TRAJECTORY_HASH_LIMIT,
        description: "Opaque hash of this run's produced checkpoint",
      },
      parentCheckpointHash: {
        type: "string",
        minLength: 8,
        maxLength: TRAJECTORY_HASH_LIMIT,
        description:
          "Parent checkpoint hash; omitted only on the genesis SFT anchor",
      },
      corpusManifestHash: {
        type: "string",
        pattern: "^sha256:[a-f0-9]{64}$",
      },
      baseModelHash: {
        type: "string",
        minLength: 8,
        maxLength: TRAJECTORY_HASH_LIMIT,
      },
      hyperparameters: {
        type: "object",
        additionalProperties: {
          oneOf: [
            { type: "string", maxLength: 256 },
            { type: "number" },
            { type: "boolean" },
          ],
        },
        propertyNames: {
          type: "string",
          minLength: 1,
          maxLength: TRAJECTORY_ID_LIMIT,
        },
        maxProperties: CHECKPOINT_LINEAGE_HYPERPARAM_KEY_LIMIT,
      },
      criticVersions: {
        type: "array",
        minItems: 0,
        maxItems: CHECKPOINT_LINEAGE_CRITIC_PIN_LIMIT,
        description:
          "C3 critic version pins. Completeness lint for candidate emission requires ≥1 entry.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["rubricId", "rubricVersion", "contentHash"],
          properties: {
            rubricId: {
              type: "string",
              minLength: 1,
              maxLength: TRAJECTORY_ID_LIMIT,
            },
            rubricVersion: {
              type: "string",
              minLength: 1,
              maxLength: TRAJECTORY_ID_LIMIT,
            },
            contentHash: {
              type: "string",
              pattern: "^sha256:[a-f0-9]{64}$",
            },
          },
        },
      },
      stage: { type: "string", enum: ["SFT", "GRPO"] },
      evalVerdicts: {
        type: "array",
        maxItems: CHECKPOINT_LINEAGE_EVAL_VERDICT_LIMIT,
        description: "Eval verdicts slot (may be empty pending CI fill)",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["verdictId", "outcome"],
          properties: {
            verdictId: {
              type: "string",
              minLength: 1,
              maxLength: TRAJECTORY_ID_LIMIT,
            },
            outcome: {
              type: "string",
              enum: ["pass", "fail", "skip", "deferred"],
            },
            evidenceHash: {
              type: "string",
              minLength: 8,
              maxLength: TRAJECTORY_HASH_LIMIT,
            },
          },
        },
      },
      supersededBy: {
        type: "string",
        minLength: 1,
        maxLength: TRAJECTORY_ID_LIMIT,
        description: "Successor runId when this row was corrected",
      },
      recordedAt: {
        type: "string",
        minLength: 1,
        maxLength: TRAJECTORY_HASH_LIMIT,
      },
    },
  };
}

export function proveCheckpointLineageSchemaMicroRun(opts: {
  subjectId: string;
  deviceId: string;
  onTelemetry?: (e: CheckpointLineageTelemetryEvent) => void;
}): {
  registry: CheckpointLineageRegistry;
  genesis: CheckpointLineageRow;
  grpo: CheckpointLineageRow;
  revision: number;
} {
  const tel =
    opts.onTelemetry !== undefined ? { onTelemetry: opts.onTelemetry } : {};

  const registry = openCheckpointLineageRegistry({
    backend: "memory",
    ...tel,
  });

  const corpus =
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const criticHash =
    "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  const genesis = registry.appendCommitted({
    row: {
      schemaVersion: CHECKPOINT_LINEAGE_SCHEMA_VERSION,
      runId: "run.lineage.genesis",
      subjectId: opts.subjectId,
      deviceId: opts.deviceId,
      locality: "on-device",
      checkpointHash: "ckpt:sha256:genesis00000001",
      corpusManifestHash: corpus,
      baseModelHash: "base:sha256:model0000000001",
      hyperparameters: { lr: 1e-4, epochs: 1 },
      criticVersions: [
        {
          rubricId: "rubric.core",
          rubricVersion: "1.0.0",
          contentHash: criticHash,
        },
      ],
      stage: "SFT",
      evalVerdicts: [],
      recordedAt: "2026-07-16T12:00:00.000Z",
    },
    ...tel,
  });

  const grpo = registry.appendCommitted({
    row: {
      schemaVersion: CHECKPOINT_LINEAGE_SCHEMA_VERSION,
      runId: "run.lineage.grpo.1",
      subjectId: opts.subjectId,
      deviceId: opts.deviceId,
      locality: "on-device",
      checkpointHash: "ckpt:sha256:grpo000000000001",
      parentCheckpointHash: genesis.row.checkpointHash,
      corpusManifestHash: corpus,
      baseModelHash: "base:sha256:model0000000001",
      hyperparameters: { lr: 5e-5, groupSize: 4, clipEps: 0.2 },
      criticVersions: [
        {
          rubricId: "rubric.core",
          rubricVersion: "1.0.0",
          contentHash: criticHash,
        },
      ],
      stage: "GRPO",
      evalVerdicts: [
        { verdictId: "micro.golden", outcome: "pass" },
      ],
      recordedAt: "2026-07-16T12:05:00.000Z",
    },
    expectedRevision: genesis.revision,
    ...tel,
  });

  return {
    registry,
    genesis: genesis.row,
    grpo: grpo.row,
    revision: grpo.revision,
  };
}

/** End-to-end fs WAL micro-run: commit, reopen, read committed tip. */
export function proveCheckpointLineageWalMicroRun(opts: {
  rootDir: string;
  subjectId: string;
  deviceId: string;
  onTelemetry?: (e: CheckpointLineageTelemetryEvent) => void;
}): {
  genesis: CheckpointLineageRow;
  grpo: CheckpointLineageRow;
  revision: number;
  recovered: LineageReadResult;
} {
  const tel =
    opts.onTelemetry !== undefined ? { onTelemetry: opts.onTelemetry } : {};

  const registry = openCheckpointLineageRegistry({
    backend: "fs",
    rootDir: opts.rootDir,
    ...tel,
  });

  const corpus =
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const criticHash =
    "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  const genesis = registry.appendCommitted({
    row: {
      schemaVersion: CHECKPOINT_LINEAGE_SCHEMA_VERSION,
      runId: "run.wal.genesis",
      subjectId: opts.subjectId,
      deviceId: opts.deviceId,
      locality: "on-device",
      checkpointHash: "ckpt:sha256:wal-genesis000001",
      corpusManifestHash: corpus,
      baseModelHash: "base:sha256:model0000000001",
      hyperparameters: { lr: 1e-4 },
      criticVersions: [
        {
          rubricId: "rubric.core",
          rubricVersion: "1.0.0",
          contentHash: criticHash,
        },
      ],
      stage: "SFT",
      evalVerdicts: [],
      recordedAt: "2026-07-16T13:00:00.000Z",
    },
    ...tel,
  });

  const grpo = registry.appendCommitted({
    row: {
      schemaVersion: CHECKPOINT_LINEAGE_SCHEMA_VERSION,
      runId: "run.wal.grpo.1",
      subjectId: opts.subjectId,
      deviceId: opts.deviceId,
      locality: "on-device",
      checkpointHash: "ckpt:sha256:wal-grpo000000001",
      parentCheckpointHash: genesis.row.checkpointHash,
      corpusManifestHash: corpus,
      baseModelHash: "base:sha256:model0000000001",
      hyperparameters: { groupSize: 4 },
      criticVersions: [
        {
          rubricId: "rubric.core",
          rubricVersion: "1.0.0",
          contentHash: criticHash,
        },
      ],
      stage: "GRPO",
      evalVerdicts: [{ verdictId: "wal.micro", outcome: "pass" }],
      recordedAt: "2026-07-16T13:05:00.000Z",
    },
    expectedRevision: genesis.revision,
    ...tel,
  });

  const reopened = openCheckpointLineageRegistry({
    backend: "fs",
    rootDir: opts.rootDir,
    ...tel,
  });
  const recovered = reopened.getByRunId({
    subjectId: opts.subjectId,
    runId: grpo.row.runId,
    deviceId: opts.deviceId,
    ...tel,
  });

  return {
    genesis: genesis.row,
    grpo: grpo.row,
    revision: grpo.revision,
    recovered,
  };
}

// ---------------------------------------------------------------------------
// Completeness linter + candidate emission CI gate
// ---------------------------------------------------------------------------

/** Fixture directory relative to repo root. */
export const CHECKPOINT_LINEAGE_FIXTURE_DIR =
  "training/pipeline/fixtures/checkpoint-lineage" as const;

/** Known-bad fixture: schema-shaped row with empty criticVersions. */
export const CHECKPOINT_LINEAGE_VIOLATION_MISSING_CRITICS =
  "violation-missing-critics.json" as const;

/** Soft cap on candidate admission cache entries (idempotent replay). */
export const CHECKPOINT_LINEAGE_CANDIDATE_CACHE_LIMIT = 256;

export type LineageCompletenessLintOk = {
  ok: true;
  row: CheckpointLineageRow;
  complete: true;
};

export type LineageCompletenessLintFail = {
  ok: false;
  failureClass: CheckpointLineageFailureClass;
  detail: string;
  runId?: string;
  subjectId?: string;
};

export type LineageCompletenessLintResult =
  | LineageCompletenessLintOk
  | LineageCompletenessLintFail;

export type CandidateEmissionRequest = {
  schemaVersion?: string;
  candidateId: string;
  subjectId: string;
  deviceId: string;
  /** Lineage run that produced the candidate checkpoint. */
  lineageRunId: string;
  /** Candidate checkpoint hash — must match the lineage row tip. */
  checkpointHash: string;
};

export type CandidateEmissionAdmitted = {
  ok: true;
  candidateId: string;
  row: CheckpointLineageRow;
  idempotentReplay: boolean;
};

const candidateAdmitCache = new Map<
  string,
  { row: CheckpointLineageRow; subjectId: string }
>();

function candidateCacheKey(subjectId: string, candidateId: string): string {
  return `${subjectId}\0${candidateId}`;
}

/**
 * Completeness rules for a lineage row leaving C4 (candidate emission).
 * Structural schema may allow empty criticVersions; emission must not.
 */
export function lintCheckpointLineageCompleteness(
  input: unknown,
  opts?: {
    subjectId?: string;
    deviceId?: string;
    requireParentUnlessGenesis?: boolean;
    onTelemetry?: (e: CheckpointLineageTelemetryEvent) => void;
  },
): LineageCompletenessLintResult {
  const subjectId = opts?.subjectId ?? "lineage";
  const deviceId = opts?.deviceId ?? "ci";

  const parsed = parseCheckpointLineageRow(input);
  if (!parsed.ok) {
    emit(opts?.onTelemetry, {
      event: "learning.lineage.lint",
      outcome: "fail",
      subjectId,
      deviceId,
      failureClass: parsed.failureClass,
      complete: false,
    });
    return {
      ok: false,
      failureClass: parsed.failureClass,
      detail: parsed.detail,
      subjectId,
    };
  }

  const row = parsed.row;
  if (opts?.subjectId !== undefined && row.subjectId !== opts.subjectId) {
    emit(opts?.onTelemetry, {
      event: "learning.lineage.lint",
      outcome: "fail",
      subjectId: opts.subjectId,
      deviceId,
      runId: row.runId,
      failureClass: "lineage.subject_scope",
      complete: false,
    });
    return {
      ok: false,
      failureClass: "lineage.subject_scope",
      detail: "lineage row subjectId does not match lint scope",
      runId: row.runId,
      subjectId: opts.subjectId,
    };
  }

  if (row.criticVersions.length < 1) {
    emit(opts?.onTelemetry, {
      event: "learning.lineage.lint",
      outcome: "fail",
      subjectId: row.subjectId,
      deviceId,
      runId: row.runId,
      stage: row.stage,
      failureClass: "lineage.missing_critics",
      complete: false,
    });
    return {
      ok: false,
      failureClass: "lineage.missing_critics",
      detail:
        "complete lineage requires ≥1 criticVersions pin (C3) before candidate emission",
      runId: row.runId,
      subjectId: row.subjectId,
    };
  }

  if (Object.keys(row.hyperparameters).length < 1) {
    emit(opts?.onTelemetry, {
      event: "learning.lineage.lint",
      outcome: "fail",
      subjectId: row.subjectId,
      deviceId,
      runId: row.runId,
      failureClass: "lineage.missing_hyperparameters",
      complete: false,
    });
    return {
      ok: false,
      failureClass: "lineage.missing_hyperparameters",
      detail: "complete lineage requires ≥1 hyperparameter entry",
      runId: row.runId,
      subjectId: row.subjectId,
    };
  }

  // evalVerdicts is a required slot (may be empty during train; presence checked by schema).
  if (!Array.isArray(row.evalVerdicts)) {
    emit(opts?.onTelemetry, {
      event: "learning.lineage.lint",
      outcome: "fail",
      subjectId: row.subjectId,
      deviceId,
      runId: row.runId,
      failureClass: "lineage.incomplete",
      complete: false,
    });
    return {
      ok: false,
      failureClass: "lineage.incomplete",
      detail: "complete lineage requires evalVerdicts slot",
      runId: row.runId,
      subjectId: row.subjectId,
    };
  }

  if (opts?.requireParentUnlessGenesis !== false) {
    const isGenesis =
      row.stage === "SFT" && row.parentCheckpointHash === undefined;
    try {
      assertParentHashChainRule(row, { isGenesis });
    } catch (err) {
      if (err instanceof CheckpointLineageContractError) {
        emit(opts?.onTelemetry, {
          event: "learning.lineage.lint",
          outcome: "fail",
          subjectId: row.subjectId,
          deviceId,
          runId: row.runId,
          failureClass: err.obligation,
          complete: false,
        });
        return {
          ok: false,
          failureClass: err.obligation,
          detail: err.message,
          runId: row.runId,
          subjectId: row.subjectId,
        };
      }
      throw err;
    }
  }

  emit(opts?.onTelemetry, {
    event: "learning.lineage.lint",
    outcome: "ok",
    subjectId: row.subjectId,
    deviceId,
    runId: row.runId,
    stage: row.stage,
    checkpointHash: row.checkpointHash,
    complete: true,
  });

  return { ok: true, row, complete: true };
}

/**
 * Admit a candidate for emission only when the referenced lineage row exists,
 * matches checkpointHash, and passes completeness lint.
 */
export function admitCandidateEmission(
  request: CandidateEmissionRequest,
  registry: CheckpointLineageRegistry,
  opts?: {
    onTelemetry?: (e: CheckpointLineageTelemetryEvent) => void;
  },
): CandidateEmissionAdmitted | LineageCompletenessLintFail {
  const { subjectId, deviceId, candidateId, lineageRunId, checkpointHash } =
    request;

  if (
    typeof candidateId !== "string" ||
    candidateId.length < 1 ||
    candidateId.length > TRAJECTORY_ID_LIMIT
  ) {
    emit(opts?.onTelemetry, {
      event: "learning.lineage.candidate_admit",
      outcome: "fail",
      subjectId,
      deviceId,
      candidateId,
      failureClass: "lineage.validation",
    });
    return {
      ok: false,
      failureClass: "lineage.validation",
      detail: "candidateId must be a non-empty id within length limits",
      subjectId,
    };
  }

  const cacheKey = candidateCacheKey(subjectId, candidateId);
  const cached = candidateAdmitCache.get(cacheKey);
  if (cached) {
    if (cached.subjectId !== subjectId) {
      return {
        ok: false,
        failureClass: "lineage.subject_scope",
        detail: "cross-subject candidate cache hit denied",
        subjectId,
      };
    }
    if (
      cached.row.runId !== lineageRunId ||
      cached.row.checkpointHash !== checkpointHash
    ) {
      emit(opts?.onTelemetry, {
        event: "learning.lineage.candidate_admit",
        outcome: "fail",
        subjectId,
        deviceId,
        candidateId,
        runId: lineageRunId,
        failureClass: "lineage.idempotent_conflict",
      });
      return {
        ok: false,
        failureClass: "lineage.idempotent_conflict",
        detail: "candidateId replay with conflicting lineage binding",
        runId: lineageRunId,
        subjectId,
      };
    }
    emit(opts?.onTelemetry, {
      event: "learning.lineage.candidate_admit",
      outcome: "ok",
      subjectId,
      deviceId,
      candidateId,
      runId: cached.row.runId,
      checkpointHash: cached.row.checkpointHash,
      idempotentReplay: true,
      complete: true,
    });
    return {
      ok: true,
      candidateId,
      row: cached.row,
      idempotentReplay: true,
    };
  }

  const read = registry.getByRunId({
    subjectId,
    runId: lineageRunId,
    deviceId,
    ...(opts?.onTelemetry !== undefined
      ? { onTelemetry: opts.onTelemetry }
      : {}),
  });

  if (read.kind === "empty") {
    emit(opts?.onTelemetry, {
      event: "learning.lineage.candidate_admit",
      outcome: "fail",
      subjectId,
      deviceId,
      candidateId,
      runId: lineageRunId,
      failureClass: "lineage.empty",
    });
    return {
      ok: false,
      failureClass: "lineage.empty",
      detail: "no lineage history for subject — cannot emit candidate",
      runId: lineageRunId,
      subjectId,
    };
  }

  if (read.kind === "not_found") {
    emit(opts?.onTelemetry, {
      event: "learning.lineage.candidate_admit",
      outcome: "fail",
      subjectId,
      deviceId,
      candidateId,
      runId: lineageRunId,
      failureClass: "lineage.candidate_denied",
    });
    return {
      ok: false,
      failureClass: "lineage.candidate_denied",
      detail:
        "candidate emission rejected — lineage runId not found for subject",
      runId: lineageRunId,
      subjectId,
    };
  }

  if (read.row.checkpointHash !== checkpointHash) {
    emit(opts?.onTelemetry, {
      event: "learning.lineage.candidate_admit",
      outcome: "fail",
      subjectId,
      deviceId,
      candidateId,
      runId: lineageRunId,
      checkpointHash,
      failureClass: "lineage.checkpoint_mismatch",
    });
    return {
      ok: false,
      failureClass: "lineage.checkpoint_mismatch",
      detail: "candidate checkpointHash does not match lineage row",
      runId: lineageRunId,
      subjectId,
    };
  }

  const linted = lintCheckpointLineageCompleteness(read.row, {
    subjectId,
    deviceId,
    ...(opts?.onTelemetry !== undefined
      ? { onTelemetry: opts.onTelemetry }
      : {}),
  });
  if (!linted.ok) {
    emit(opts?.onTelemetry, {
      event: "learning.lineage.candidate_admit",
      outcome: "fail",
      subjectId,
      deviceId,
      candidateId,
      runId: lineageRunId,
      failureClass: linted.failureClass,
      complete: false,
    });
    return linted;
  }

  if (candidateAdmitCache.size >= CHECKPOINT_LINEAGE_CANDIDATE_CACHE_LIMIT) {
    const oldest = candidateAdmitCache.keys().next().value;
    if (oldest !== undefined) candidateAdmitCache.delete(oldest);
  }
  candidateAdmitCache.set(cacheKey, {
    row: linted.row,
    subjectId,
  });

  emit(opts?.onTelemetry, {
    event: "learning.lineage.candidate_admit",
    outcome: "ok",
    subjectId,
    deviceId,
    candidateId,
    runId: linted.row.runId,
    checkpointHash: linted.row.checkpointHash,
    stage: linted.row.stage,
    complete: true,
  });

  return {
    ok: true,
    candidateId,
    row: linted.row,
    idempotentReplay: false,
  };
}

export function admitCandidateEmissionOrThrow(
  request: CandidateEmissionRequest,
  registry: CheckpointLineageRegistry,
  opts?: {
    onTelemetry?: (e: CheckpointLineageTelemetryEvent) => void;
  },
): CandidateEmissionAdmitted {
  const result = admitCandidateEmission(request, registry, opts);
  if (!result.ok) {
    throw new CheckpointLineageContractError(result.detail, {
      obligation: result.failureClass,
      ...(result.subjectId !== undefined ? { subjectId: result.subjectId } : {}),
      deviceId: request.deviceId,
      ...(result.runId !== undefined ? { failingSlice: result.runId } : {}),
    });
  }
  return result;
}

export function resetCheckpointLineageCandidateCache(): void {
  candidateAdmitCache.clear();
}

/**
 * CI gate: missing-critics fixture fails lint; micro-run complete row admits
 * candidate emission; emission without a lineage row is denied.
 */
export function proveCheckpointLineageCompletenessGateCi(opts?: {
  repoRoot?: string;
  subjectId?: string;
  deviceId?: string;
  onTelemetry?: (e: CheckpointLineageTelemetryEvent) => void;
}): {
  ok: true;
  violationRejected: true;
  violationFailureClass: CheckpointLineageFailureClass;
  microRunAdmitted: true;
  missingRowDenied: true;
} {
  const subjectId = opts?.subjectId ?? "subj.lineage.gate";
  const deviceId = opts?.deviceId ?? "dev.lineage.gate";
  const tel =
    opts?.onTelemetry !== undefined ? { onTelemetry: opts.onTelemetry } : {};

  const repoRoot = opts?.repoRoot ?? process.cwd();
  const fixturePath = path.join(
    repoRoot,
    CHECKPOINT_LINEAGE_FIXTURE_DIR,
    CHECKPOINT_LINEAGE_VIOLATION_MISSING_CRITICS,
  );
  if (!existsSync(fixturePath)) {
    throw new CheckpointLineageContractError(
      `missing lineage completeness fixture: ${CHECKPOINT_LINEAGE_FIXTURE_DIR}/${CHECKPOINT_LINEAGE_VIOLATION_MISSING_CRITICS}`,
      {
        obligation: "lineage.not_found",
        subjectId,
        failingSlice: fixturePath,
      },
    );
  }

  const violationRaw = JSON.parse(readFileSync(fixturePath, "utf8")) as unknown;
  const violationLint = lintCheckpointLineageCompleteness(violationRaw, {
    deviceId,
    ...tel,
  });
  if (
    violationLint.ok ||
    violationLint.failureClass !== "lineage.missing_critics"
  ) {
    throw new CheckpointLineageContractError(
      `expected missing-critics fixture to fail lineage.missing_critics, got ${
        violationLint.ok ? "complete" : violationLint.failureClass
      }`,
      { obligation: "lineage.incomplete", subjectId },
    );
  }

  resetCheckpointLineageCandidateCache();
  resetCheckpointLineageBackendLog();
  const proved = proveCheckpointLineageSchemaMicroRun({
    subjectId,
    deviceId,
    ...tel,
  });

  const admitted = admitCandidateEmission(
    {
      candidateId: "cand.lineage.micro.1",
      subjectId,
      deviceId,
      lineageRunId: proved.grpo.runId,
      checkpointHash: proved.grpo.checkpointHash,
    },
    proved.registry,
    tel,
  );
  if (!admitted.ok) {
    throw new CheckpointLineageContractError(
      `micro-run candidate should admit: ${admitted.detail}`,
      {
        obligation: admitted.failureClass,
        subjectId,
        ...(admitted.runId !== undefined
          ? { failingSlice: admitted.runId }
          : {}),
      },
    );
  }

  const denied = admitCandidateEmission(
    {
      candidateId: "cand.lineage.missing",
      subjectId,
      deviceId,
      lineageRunId: "run.does.not.exist",
      checkpointHash: "ckpt:sha256:missing000000001",
    },
    proved.registry,
    tel,
  );
  if (denied.ok || denied.failureClass !== "lineage.candidate_denied") {
    throw new CheckpointLineageContractError(
      `expected missing lineage run to deny candidate emission`,
      { obligation: "lineage.incomplete", subjectId },
    );
  }

  return {
    ok: true,
    violationRejected: true,
    violationFailureClass: violationLint.failureClass,
    microRunAdmitted: true,
    missingRowDenied: true,
  };
}

