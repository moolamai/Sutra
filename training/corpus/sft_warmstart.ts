/**
 * SFT warmstart trainer on versioned C1 corpus manifests (C4).
 *
 * Mid-train anchor doctrine: supervised fine-tune on grammar-filtered shards,
 * emit an anchored checkpoint whose metadata pins the corpus manifest hash.
 * RET-tagged documents never enter weights. Unparseable traces are excluded
 * via the same harness grammar contract as C1 distillation (injectable gate).
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  CORPUS_MANIFEST_SCHEMA_VERSION,
  canonicalManifestSha256,
  parseCorpusManifest,
  type CorpusKnowledgeMode,
  type CorpusManifest,
  type CorpusManifestTelemetry,
} from "./build.js";

export const SFT_WARMSTART_SCHEMA_VERSION = "training.sft-warmstart.v1" as const;
export const SFT_ANCHORED_CHECKPOINT_SCHEMA_VERSION =
  "training.sft-anchored-checkpoint.v1" as const;

/** Soft cap on SFT examples per warmstart run (NFR). */
export const SFT_EXAMPLE_LIMIT = 512;

export type SftWarmstartFailureClass =
  | "sft.schema"
  | "sft.manifest_drift"
  | "sft.ret_policy"
  | "sft.lane_tag"
  | "sft.grammar_filter"
  | "sft.empty_after_filter"
  | "sft.subject_scope"
  | "sft.section_limit"
  | "sft.floating_checkpoint"
  | "sft.missing_checkpoint"
  | "sft.lineage_corrupt"
  | "sft.invalid_loss"
  | "sft.idempotent_conflict"
  | "sft.unanchored_grpo"
  | "sft.missing_sft_parent";

export type SftWarmstartTelemetryEvent = {
  event:
    | "training.sft_warmstart.manifest"
    | "training.sft_warmstart.filter"
    | "training.sft_warmstart.train"
    | "training.sft_warmstart.anchor"
    | "training.sft_warmstart.grpo_admit"
    | "training.sft_warmstart.grpo_lint";
  outcome: "ok" | "fail" | "advisory";
  subjectId: string;
  deviceId: string;
  manifestId?: string;
  corpusManifestHash?: string;
  checkpointHash?: string;
  jobId?: string;
  accepted?: number;
  dropped?: number;
  loss?: number;
  failureClass?: SftWarmstartFailureClass;
  idempotentReplay?: boolean;
};

export class SftWarmstartContractError extends Error {
  readonly obligation: SftWarmstartFailureClass;
  readonly subjectId: string | undefined;
  readonly deviceId: string | undefined;
  readonly failingSlice: string | undefined;

  constructor(
    message: string,
    meta: {
      obligation: SftWarmstartFailureClass;
      subjectId?: string;
      deviceId?: string;
      failingSlice?: string;
    },
  ) {
    super(message);
    this.name = "SftWarmstartContractError";
    this.obligation = meta.obligation;
    this.subjectId = meta.subjectId;
    this.deviceId = meta.deviceId;
    this.failingSlice = meta.failingSlice;
  }
}

/**
 * One supervised example derived from a C1 shard / distillation trace.
 * Optional harness frames — when present, must pass the grammar gate.
 */
export type SftTrainingExample = {
  exampleId: string;
  subjectId: string;
  deviceId: string;
  shardId: string;
  docId: string;
  knowledgeMode: CorpusKnowledgeMode;
  laneCode: string;
  /** Opaque content digest — never raw learner text in telemetry. */
  contentHash: string;
  /** Harness frames for grammar filter (C1 distillation contract). */
  frames?: readonly unknown[];
};

export type SftGrammarGateResult =
  | { ok: true }
  | { ok: false; violationClass: string; detail: string };

/** Same role as C1 distillation grammar filter — unparseable traces excluded. */
export type SftTraceGrammarGate = (
  example: SftTrainingExample,
) => SftGrammarGateResult;

export type SftAnchoredCheckpoint = {
  schemaVersion: typeof SFT_ANCHORED_CHECKPOINT_SCHEMA_VERSION;
  /** Content-addressed SFT checkpoint id. */
  checkpointHash: string;
  /** Exact base model / checkpoint warmstart started from. */
  baseCheckpointHash: string;
  /** Canonical corpus manifest hash pinned in metadata. */
  corpusManifestHash: string;
  manifestId: string;
  manifestVersion: string;
  parentCheckpointHash?: string;
  acceptedExampleCount: number;
  droppedExampleCount: number;
  supervisedLoss: number;
  subjectId: string;
  deviceId: string;
  publishedAt: string;
  /** Mid-train anchor — GRPO must reference this row. */
  sftWarmstartCompleted: true;
};

export type SftWarmstartResult = {
  ok: true;
  schemaVersion: typeof SFT_WARMSTART_SCHEMA_VERSION;
  manifest: CorpusManifest;
  corpusManifestHash: string;
  accepted: SftTrainingExample[];
  dropped: Array<{
    exampleId: string;
    reason: SftWarmstartFailureClass;
    detail: string;
  }>;
  supervisedLoss: number;
  checkpoint: SftAnchoredCheckpoint;
  idempotentReplay: boolean;
};

function assertOpaqueHash(
  hash: string,
  field: string,
  subjectId?: string,
): string {
  const trimmed = typeof hash === "string" ? hash.trim() : "";
  if (!trimmed) {
    throw new SftWarmstartContractError(`${field} required`, {
      obligation: "sft.missing_checkpoint",
      ...(subjectId !== undefined ? { subjectId } : {}),
      failingSlice: field,
    });
  }
  if (trimmed.toLowerCase() === "latest") {
    throw new SftWarmstartContractError(
      `floating checkpoint 'latest' forbidden on ${field}`,
      {
        obligation: "sft.floating_checkpoint",
        ...(subjectId !== undefined ? { subjectId } : {}),
        failingSlice: field,
      },
    );
  }
  if (trimmed.length < 8 || trimmed.length > 128) {
    throw new SftWarmstartContractError(`${field} required`, {
      obligation: "sft.missing_checkpoint",
      ...(subjectId !== undefined ? { subjectId } : {}),
      failingSlice: field,
    });
  }
  return trimmed;
}

/**
 * Validate C1 corpus policy for SFT: RET excluded from weights; lane tags present.
 */
export function assertSftCorpusPolicy(
  manifest: CorpusManifest,
  opts?: { subjectId?: string; deviceId?: string },
): void {
  if (manifest.schemaVersion !== CORPUS_MANIFEST_SCHEMA_VERSION) {
    throw new SftWarmstartContractError("unsupported corpus manifest schema", {
      obligation: "sft.schema",
      ...(opts?.subjectId !== undefined ? { subjectId: opts.subjectId } : {}),
    });
  }
  if (!manifest.weightTrainingPolicy.excludeKnowledgeModes.includes("RET")) {
    throw new SftWarmstartContractError(
      "SFT warmstart blocked — weightTrainingPolicy must exclude RET",
      {
        obligation: "sft.ret_policy",
        ...(opts?.subjectId !== undefined ? { subjectId: opts.subjectId } : {}),
        failingSlice: "weightTrainingPolicy.excludeKnowledgeModes",
      },
    );
  }
  if (!Array.isArray(manifest.laneCodes) || manifest.laneCodes.length < 1) {
    throw new SftWarmstartContractError("SFT warmstart requires lane codes", {
      obligation: "sft.lane_tag",
      ...(opts?.subjectId !== undefined ? { subjectId: opts.subjectId } : {}),
    });
  }
  for (const src of manifest.sources) {
    if (src.knowledgeMode === "RET") {
      throw new SftWarmstartContractError(
        `SFT on RET-tagged source ${src.sourceId} is blocked by corpus policy`,
        {
          obligation: "sft.ret_policy",
          ...(opts?.subjectId !== undefined ? { subjectId: opts.subjectId } : {}),
          failingSlice: src.sourceId,
        },
      );
    }
    if (!manifest.laneCodes.includes(src.laneCode)) {
      throw new SftWarmstartContractError(
        `source ${src.sourceId} laneCode not declared on manifest`,
        {
          obligation: "sft.lane_tag",
          ...(opts?.subjectId !== undefined ? { subjectId: opts.subjectId } : {}),
          failingSlice: src.laneCode,
        },
      );
    }
  }
}

/**
 * Detect corpus manifest hash drift vs the hash pinned at prior SFT.
 */
export function assertCorpusManifestHashFresh(
  manifest: CorpusManifest,
  expectedCorpusManifestHash: string,
  opts?: { subjectId?: string; deviceId?: string },
): string {
  const actual = canonicalManifestSha256(manifest);
  const expected = assertOpaqueHash(
    expectedCorpusManifestHash,
    "corpusManifestHash",
    opts?.subjectId,
  );
  if (actual !== expected) {
    throw new SftWarmstartContractError(
      "corpus manifest hash drift — re-run SFT on the new manifest before training",
      {
        obligation: "sft.manifest_drift",
        ...(opts?.subjectId !== undefined ? { subjectId: opts.subjectId } : {}),
        ...(opts?.deviceId !== undefined ? { deviceId: opts.deviceId } : {}),
        failingSlice: actual,
      },
    );
  }
  return actual;
}

/**
 * Default grammar gate when examples carry harness frames: require SESSION_START
 * + TURN_COMPLETE tags (same contract surface as C1 distillation). Injectable
 * gate should wrap evaluateTeacherTraceGrammar in the pipeline path.
 */
export function defaultSftHarnessGrammarGate(
  example: SftTrainingExample,
): SftGrammarGateResult {
  const frames = example.frames;
  if (!Array.isArray(frames) || frames.length < 1) {
    return {
      ok: false,
      violationClass: "missing_required_tag",
      detail: "frames empty — missing SESSION_START and TURN_COMPLETE",
    };
  }
  const types = frames.map((f) =>
    f && typeof f === "object" && "type" in f
      ? String((f as { type: unknown }).type)
      : "",
  );
  if (!types.includes("SESSION_START")) {
    return {
      ok: false,
      violationClass: "missing_required_tag",
      detail: "missing required tag SESSION_START",
    };
  }
  if (!types.includes("TURN_COMPLETE")) {
    return {
      ok: false,
      violationClass: "missing_required_tag",
      detail: "missing required tag TURN_COMPLETE",
    };
  }
  return { ok: true };
}

/**
 * Filter examples: drop RET, wrong subject, grammar failures.
 */
export function filterSftExamplesForWarmstart(input: {
  examples: readonly SftTrainingExample[];
  manifest: CorpusManifest;
  subjectId: string;
  deviceId: string;
  grammarGate?: SftTraceGrammarGate;
  onTelemetry?: (e: SftWarmstartTelemetryEvent) => void;
}): {
  accepted: SftTrainingExample[];
  dropped: Array<{
    exampleId: string;
    reason: SftWarmstartFailureClass;
    detail: string;
  }>;
} {
  if (!input.subjectId) {
    throw new SftWarmstartContractError("subjectId required", {
      obligation: "sft.subject_scope",
    });
  }
  if (!Array.isArray(input.examples) || input.examples.length === 0) {
    throw new SftWarmstartContractError("SFT warmstart requires examples", {
      obligation: "sft.empty_after_filter",
      subjectId: input.subjectId,
      deviceId: input.deviceId,
    });
  }
  if (input.examples.length > SFT_EXAMPLE_LIMIT) {
    throw new SftWarmstartContractError(
      `SFT example batch exceeds ${SFT_EXAMPLE_LIMIT}`,
      {
        obligation: "sft.section_limit",
        subjectId: input.subjectId,
      },
    );
  }

  const gate = input.grammarGate ?? defaultSftHarnessGrammarGate;
  const laneSet = new Set(input.manifest.laneCodes);
  const accepted: SftTrainingExample[] = [];
  const dropped: Array<{
    exampleId: string;
    reason: SftWarmstartFailureClass;
    detail: string;
  }> = [];

  for (const ex of input.examples) {
    if (ex.subjectId !== input.subjectId) {
      throw new SftWarmstartContractError(
        "cross-subject SFT example refused",
        {
          obligation: "sft.subject_scope",
          subjectId: ex.subjectId,
          deviceId: ex.deviceId,
          failingSlice: ex.subjectId,
        },
      );
    }
    if (ex.knowledgeMode === "RET") {
      dropped.push({
        exampleId: ex.exampleId,
        reason: "sft.ret_policy",
        detail: "RET-tagged documents blocked from SFT weights",
      });
      continue;
    }
    if (!laneSet.has(ex.laneCode)) {
      dropped.push({
        exampleId: ex.exampleId,
        reason: "sft.lane_tag",
        detail: `laneCode ${ex.laneCode} not on manifest`,
      });
      continue;
    }
    const grammar = gate(ex);
    if (!grammar.ok) {
      dropped.push({
        exampleId: ex.exampleId,
        reason: "sft.grammar_filter",
        detail: `${grammar.violationClass}: ${grammar.detail}`,
      });
      continue;
    }
    accepted.push(ex);
  }

  input.onTelemetry?.({
    event: "training.sft_warmstart.filter",
    outcome: accepted.length > 0 ? "ok" : "fail",
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    manifestId: input.manifest.manifestId,
    accepted: accepted.length,
    dropped: dropped.length,
    ...(accepted.length === 0
      ? { failureClass: "sft.empty_after_filter" as const }
      : {}),
  });

  return { accepted, dropped };
}

/**
 * Deterministic supervised loss proxy over accepted example content hashes.
 * No raw text — content-addressed only.
 */
export function computeSupervisedLoss(
  accepted: readonly SftTrainingExample[],
): number {
  if (accepted.length === 0) {
    throw new SftWarmstartContractError(
      "cannot compute supervised loss on empty accepted set",
      { obligation: "sft.empty_after_filter" },
    );
  }
  let acc = 0;
  for (const ex of accepted) {
    const digest = createHash("sha256")
      .update(ex.contentHash)
      .update("|")
      .update(ex.exampleId)
      .digest();
    // Pseudo NLL in (0, 2] from digest bytes — deterministic, finite.
    const unit = digest[0]! / 255;
    acc += 0.05 + unit * 0.2;
  }
  const loss = acc / accepted.length;
  if (!Number.isFinite(loss)) {
    throw new SftWarmstartContractError("supervised loss non-finite", {
      obligation: "sft.invalid_loss",
    });
  }
  return loss;
}

function contentAddressCheckpoint(parts: {
  baseCheckpointHash: string;
  corpusManifestHash: string;
  loss: number;
  acceptedHashes: readonly string[];
  parentCheckpointHash?: string;
}): string {
  const h = createHash("sha256");
  h.update(parts.baseCheckpointHash);
  h.update("|");
  h.update(parts.corpusManifestHash);
  h.update("|");
  h.update(String(parts.loss));
  h.update("|");
  h.update(parts.parentCheckpointHash ?? "");
  for (const id of [...parts.acceptedHashes].sort()) {
    h.update("|");
    h.update(id);
  }
  return `sha256:${h.digest("hex")}`;
}

const warmstartDecisionCache = new Map<string, SftWarmstartResult>();

/**
 * Run SFT warmstart: parse manifest → policy → grammar filter → loss → anchor.
 */
export function runSftWarmstart(input: {
  manifest: unknown;
  examples: readonly SftTrainingExample[];
  baseCheckpointHash: string;
  subjectId: string;
  deviceId: string;
  /** When set, refuse if live manifest hash differs (drift). */
  expectedCorpusManifestHash?: string;
  parentCheckpointHash?: string;
  grammarGate?: SftTraceGrammarGate;
  runId?: string;
  publishedAt?: string;
  onTelemetry?: (
    e: SftWarmstartTelemetryEvent | CorpusManifestTelemetry,
  ) => void;
}): SftWarmstartResult {
  if (!input.subjectId) {
    throw new SftWarmstartContractError("subjectId required", {
      obligation: "sft.subject_scope",
    });
  }

  if (input.runId !== undefined) {
    const cached = warmstartDecisionCache.get(input.runId);
    if (cached) {
      input.onTelemetry?.({
        event: "training.sft_warmstart.anchor",
        outcome: "ok",
        subjectId: cached.checkpoint.subjectId,
        deviceId: cached.checkpoint.deviceId,
        manifestId: cached.checkpoint.manifestId,
        corpusManifestHash: cached.corpusManifestHash,
        checkpointHash: cached.checkpoint.checkpointHash,
        loss: cached.supervisedLoss,
        idempotentReplay: true,
      });
      return { ...cached, idempotentReplay: true };
    }
  }

  const baseCheckpointHash = assertOpaqueHash(
    input.baseCheckpointHash,
    "baseCheckpointHash",
    input.subjectId,
  );
  if (input.parentCheckpointHash !== undefined) {
    assertOpaqueHash(
      input.parentCheckpointHash,
      "parentCheckpointHash",
      input.subjectId,
    );
  }

  const parsed = parseCorpusManifest(input.manifest, {
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });
  if (!parsed.ok) {
    throw new SftWarmstartContractError(parsed.message, {
      obligation: "sft.schema",
      subjectId: input.subjectId,
      deviceId: input.deviceId,
      ...(parsed.path !== undefined ? { failingSlice: parsed.path } : {}),
    });
  }
  const manifest = parsed.value;
  assertSftCorpusPolicy(manifest, {
    subjectId: input.subjectId,
    deviceId: input.deviceId,
  });

  const corpusManifestHash = canonicalManifestSha256(manifest);
  if (input.expectedCorpusManifestHash !== undefined) {
    assertCorpusManifestHashFresh(
      manifest,
      input.expectedCorpusManifestHash,
      { subjectId: input.subjectId, deviceId: input.deviceId },
    );
  }

  input.onTelemetry?.({
    event: "training.sft_warmstart.manifest",
    outcome: "ok",
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    manifestId: manifest.manifestId,
    corpusManifestHash,
  });

  const { accepted, dropped } = filterSftExamplesForWarmstart({
    examples: input.examples,
    manifest,
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    ...(input.grammarGate !== undefined
      ? { grammarGate: input.grammarGate }
      : {}),
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });

  if (accepted.length === 0) {
    throw new SftWarmstartContractError(
      "no examples remain after grammar / RET / lane filters",
      {
        obligation: "sft.empty_after_filter",
        subjectId: input.subjectId,
        deviceId: input.deviceId,
      },
    );
  }

  const supervisedLoss = computeSupervisedLoss(accepted);
  input.onTelemetry?.({
    event: "training.sft_warmstart.train",
    outcome: "ok",
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    manifestId: manifest.manifestId,
    corpusManifestHash,
    accepted: accepted.length,
    dropped: dropped.length,
    loss: supervisedLoss,
  });

  const checkpointHash = contentAddressCheckpoint({
    baseCheckpointHash,
    corpusManifestHash,
    loss: supervisedLoss,
    acceptedHashes: accepted.map((e) => e.contentHash),
    ...(input.parentCheckpointHash !== undefined
      ? { parentCheckpointHash: input.parentCheckpointHash }
      : {}),
  });

  const checkpoint: SftAnchoredCheckpoint = {
    schemaVersion: SFT_ANCHORED_CHECKPOINT_SCHEMA_VERSION,
    checkpointHash,
    baseCheckpointHash,
    corpusManifestHash,
    manifestId: manifest.manifestId,
    manifestVersion: manifest.version,
    ...(input.parentCheckpointHash !== undefined
      ? { parentCheckpointHash: input.parentCheckpointHash }
      : {}),
    acceptedExampleCount: accepted.length,
    droppedExampleCount: dropped.length,
    supervisedLoss,
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    publishedAt: input.publishedAt ?? new Date().toISOString(),
    sftWarmstartCompleted: true,
  };

  input.onTelemetry?.({
    event: "training.sft_warmstart.anchor",
    outcome: "ok",
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    manifestId: manifest.manifestId,
    corpusManifestHash,
    checkpointHash,
    loss: supervisedLoss,
    accepted: accepted.length,
    dropped: dropped.length,
  });

  const result: SftWarmstartResult = {
    ok: true,
    schemaVersion: SFT_WARMSTART_SCHEMA_VERSION,
    manifest,
    corpusManifestHash,
    accepted,
    dropped,
    supervisedLoss,
    checkpoint,
    idempotentReplay: false,
  };

  if (input.runId !== undefined) {
    warmstartDecisionCache.set(input.runId, result);
    if (warmstartDecisionCache.size > 64) {
      const first = warmstartDecisionCache.keys().next().value as
        | string
        | undefined;
      if (first !== undefined) warmstartDecisionCache.delete(first);
    }
  }

  return result;
}

/**
 * Micro-run: tiny synthetic corpus manifest + grammar-valid examples → anchor.
 */
export function proveSftWarmstartMicroRun(input: {
  subjectId: string;
  deviceId: string;
  baseCheckpointHash: string;
  manifest?: unknown;
  examples?: readonly SftTrainingExample[];
  grammarGate?: SftTraceGrammarGate;
  onTelemetry?: (
    e: SftWarmstartTelemetryEvent | CorpusManifestTelemetry,
  ) => void;
}): SftWarmstartResult {
  const lane = "pack.teacher.cbse-slice";
  const manifest =
    input.manifest ??
    ({
      schemaVersion: CORPUS_MANIFEST_SCHEMA_VERSION,
      manifestId: "corpus.sft.warmstart.micro",
      version: "1.0.0",
      title: "SFT warmstart micro corpus",
      consentClass: "synthetic",
      laneCodes: [lane],
      knowledgeModes: ["UND"],
      sources: [
        {
          sourceId: "src.sft.micro.a",
          relpath: "fixtures/sources/sft-micro.jsonl",
          licenseId: "lic.cc-by-4.0",
          knowledgeMode: "UND",
          laneCode: lane,
          contentHash:
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      ],
      filters: [
        { filterId: "flt.exclude-unknown-license", kind: "exclude_unknown_license" },
        { filterId: "flt.exclude-ret-weights", kind: "exclude_ret_from_weights" },
        { filterId: "flt.exclude-eval-overlap", kind: "exclude_eval_overlap" },
      ],
      dedupReport: {
        status: "pending",
        algorithm: "sha256+fuzzy",
        fuzzyThreshold: 0.92,
      },
      licenseLedger: [
        {
          licenseId: "lic.cc-by-4.0",
          spdxOrLabel: "CC-BY-4.0",
          licenseClass: "open",
        },
      ],
      weightTrainingPolicy: {
        excludeKnowledgeModes: ["RET"],
        requireKnownLicense: true,
      },
      determinism: {
        canonicalSort: true,
        contentAddressedShards: true,
        forbidWallClockInShardBytes: true,
      },
    } satisfies CorpusManifest);

  const examples =
    input.examples ??
    ([
      {
        exampleId: "ex.sft.1",
        subjectId: input.subjectId,
        deviceId: input.deviceId,
        shardId: "shard.weight.micro.1",
        docId: "doc.1",
        knowledgeMode: "UND",
        laneCode: lane,
        contentHash:
          "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        frames: [
          { type: "SESSION_START", protocolVersion: "sutra.streaming-turn.v1" },
          { type: "ANSWER_DELTA" },
          { type: "TURN_COMPLETE" },
        ],
      },
      {
        exampleId: "ex.sft.2",
        subjectId: input.subjectId,
        deviceId: input.deviceId,
        shardId: "shard.weight.micro.1",
        docId: "doc.2",
        knowledgeMode: "UND",
        laneCode: lane,
        contentHash:
          "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        frames: [
          { type: "SESSION_START", protocolVersion: "sutra.streaming-turn.v1" },
          { type: "THOUGHT_DELTA" },
          { type: "TURN_COMPLETE" },
        ],
      },
    ] satisfies SftTrainingExample[]);

  return runSftWarmstart({
    manifest,
    examples,
    baseCheckpointHash: input.baseCheckpointHash,
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    runId: `sft.micro.${input.subjectId}`,
    ...(input.grammarGate !== undefined
      ? { grammarGate: input.grammarGate }
      : {}),
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });
}

/** Test helper — clear idempotent warmstart cache. */
export function resetSftWarmstartCache(): void {
  warmstartDecisionCache.clear();
}

// ── Mid-train anchor gate (GRPO admission) ────────────────────────────────

export const GRPO_JOB_SCHEMA_VERSION = "training.grpo-job.v1" as const;

/** Fixture dir + seeded CI violation for unanchored RL. */
export const SFT_ANCHOR_GATE_FIXTURE_DIR = "fixtures/sft_warmstart" as const;
export const SFT_ANCHOR_GATE_VIOLATION_UNANCHORED =
  "violation-unanchored-grpo.json" as const;

/** Soft cap on concurrent linted job ids in-process. */
export const GRPO_JOB_LINT_CACHE_LIMIT = 64;

export type GrpoJobAdmissionRequest = {
  schemaVersion: typeof GRPO_JOB_SCHEMA_VERSION;
  jobId: string;
  subjectId: string;
  deviceId: string;
  /** Base the RL job claims to train from. */
  baseCheckpointHash: string;
  /** Declared C1 corpus manifest hash the job must be anchored to. */
  declaredCorpusManifestHash: string;
  /**
   * Completed SFT warmstart lineage parent — required.
   * Null / missing → unanchored RL (forbidden).
   */
  sftParent: SftAnchoredCheckpoint | null | undefined;
  policyCheckpointHash?: string;
};

export type GrpoJobLintOk = {
  ok: true;
  admitted: true;
  jobId: string;
  subjectId: string;
  deviceId: string;
  sftParentCheckpointHash: string;
  corpusManifestHash: string;
  baseCheckpointHash: string;
};

export type GrpoJobLintFail = {
  ok: false;
  admitted: false;
  jobId: string;
  subjectId: string;
  deviceId: string;
  failureClass: SftWarmstartFailureClass;
  detail: string;
};

export type GrpoJobLintResult = GrpoJobLintOk | GrpoJobLintFail;

const grpoAdmitCache = new Map<string, GrpoJobLintResult>();

/**
 * Mid-train anchor doctrine: lint a GRPO job before admission.
 * Rejects runs without a completed SFT lineage parent on the declared corpus hash.
 */
export function lintGrpoJobMidTrainAnchor(
  job: GrpoJobAdmissionRequest,
  opts?: {
    onTelemetry?: (e: SftWarmstartTelemetryEvent) => void;
  },
): GrpoJobLintResult {
  const subjectId = typeof job.subjectId === "string" ? job.subjectId.trim() : "";
  const deviceId = typeof job.deviceId === "string" ? job.deviceId.trim() : "ci";
  const jobId = typeof job.jobId === "string" ? job.jobId.trim() : "";

  if (!subjectId) {
    throw new SftWarmstartContractError("subjectId required on GRPO job", {
      obligation: "sft.subject_scope",
    });
  }
  if (!jobId || jobId.length > 128) {
    throw new SftWarmstartContractError("jobId required", {
      obligation: "sft.section_limit",
      subjectId,
      deviceId,
    });
  }

  if (job.schemaVersion !== GRPO_JOB_SCHEMA_VERSION) {
    const fail: GrpoJobLintFail = {
      ok: false,
      admitted: false,
      jobId,
      subjectId,
      deviceId,
      failureClass: "sft.schema",
      detail: `unsupported GRPO job schema: ${String(job.schemaVersion)}`,
    };
    opts?.onTelemetry?.({
      event: "training.sft_warmstart.grpo_lint",
      outcome: "fail",
      subjectId,
      deviceId,
      jobId,
      failureClass: "sft.schema",
    });
    return fail;
  }

  const cached = grpoAdmitCache.get(jobId);
  if (cached) {
    opts?.onTelemetry?.({
      event: "training.sft_warmstart.grpo_lint",
      outcome: cached.ok ? "ok" : "fail",
      subjectId: cached.subjectId,
      deviceId: cached.deviceId,
      jobId: cached.jobId,
      ...(cached.ok
        ? {
            checkpointHash: cached.sftParentCheckpointHash,
            corpusManifestHash: cached.corpusManifestHash,
          }
        : { failureClass: cached.failureClass }),
      idempotentReplay: true,
    });
    return cached;
  }

  let baseCheckpointHash: string;
  let declaredHash: string;
  try {
    baseCheckpointHash = assertOpaqueHash(
      job.baseCheckpointHash,
      "baseCheckpointHash",
      subjectId,
    );
    declaredHash = assertOpaqueHash(
      job.declaredCorpusManifestHash,
      "declaredCorpusManifestHash",
      subjectId,
    );
    if (job.policyCheckpointHash !== undefined) {
      assertOpaqueHash(job.policyCheckpointHash, "policyCheckpointHash", subjectId);
    }
  } catch (err) {
    if (err instanceof SftWarmstartContractError) {
      const fail: GrpoJobLintFail = {
        ok: false,
        admitted: false,
        jobId,
        subjectId,
        deviceId,
        failureClass: err.obligation,
        detail: err.message,
      };
      opts?.onTelemetry?.({
        event: "training.sft_warmstart.grpo_lint",
        outcome: "fail",
        subjectId,
        deviceId,
        jobId,
        failureClass: err.obligation,
      });
      cacheGrpoLint(jobId, fail);
      return fail;
    }
    throw err;
  }

  const parent = job.sftParent;
  if (parent == null) {
    const fail: GrpoJobLintFail = {
      ok: false,
      admitted: false,
      jobId,
      subjectId,
      deviceId,
      failureClass: "sft.unanchored_grpo",
      detail:
        "GRPO job rejected — no completed SFT warmstart lineage parent (mid-train anchor doctrine)",
    };
    opts?.onTelemetry?.({
      event: "training.sft_warmstart.grpo_lint",
      outcome: "fail",
      subjectId,
      deviceId,
      jobId,
      corpusManifestHash: declaredHash,
      failureClass: "sft.unanchored_grpo",
    });
    cacheGrpoLint(jobId, fail);
    return fail;
  }

  if (
    parent.schemaVersion !== SFT_ANCHORED_CHECKPOINT_SCHEMA_VERSION ||
    parent.sftWarmstartCompleted !== true
  ) {
    const fail: GrpoJobLintFail = {
      ok: false,
      admitted: false,
      jobId,
      subjectId,
      deviceId,
      failureClass: "sft.missing_sft_parent",
      detail:
        "GRPO job rejected — sftParent is not a completed SFT anchored checkpoint",
    };
    opts?.onTelemetry?.({
      event: "training.sft_warmstart.grpo_lint",
      outcome: "fail",
      subjectId,
      deviceId,
      jobId,
      failureClass: "sft.missing_sft_parent",
    });
    cacheGrpoLint(jobId, fail);
    return fail;
  }

  if (parent.subjectId !== subjectId) {
    throw new SftWarmstartContractError(
      "cross-subject SFT parent refused for GRPO admission",
      {
        obligation: "sft.subject_scope",
        subjectId,
        deviceId,
        failingSlice: parent.subjectId,
      },
    );
  }

  if (parent.corpusManifestHash !== declaredHash) {
    const fail: GrpoJobLintFail = {
      ok: false,
      admitted: false,
      jobId,
      subjectId,
      deviceId,
      failureClass: "sft.manifest_drift",
      detail:
        "corpus manifest hash drift — SFT parent does not match declared C1 corpus hash; re-run SFT",
    };
    opts?.onTelemetry?.({
      event: "training.sft_warmstart.grpo_lint",
      outcome: "fail",
      subjectId,
      deviceId,
      jobId,
      corpusManifestHash: declaredHash,
      checkpointHash: parent.checkpointHash,
      failureClass: "sft.manifest_drift",
    });
    cacheGrpoLint(jobId, fail);
    return fail;
  }

  if (parent.baseCheckpointHash !== baseCheckpointHash) {
    const fail: GrpoJobLintFail = {
      ok: false,
      admitted: false,
      jobId,
      subjectId,
      deviceId,
      failureClass: "sft.lineage_corrupt",
      detail:
        "SFT parent baseCheckpointHash does not match GRPO job base — lineage fork refused",
    };
    opts?.onTelemetry?.({
      event: "training.sft_warmstart.grpo_lint",
      outcome: "fail",
      subjectId,
      deviceId,
      jobId,
      failureClass: "sft.lineage_corrupt",
    });
    cacheGrpoLint(jobId, fail);
    return fail;
  }

  try {
    assertOpaqueHash(parent.checkpointHash, "sftParent.checkpointHash", subjectId);
  } catch (err) {
    if (err instanceof SftWarmstartContractError) {
      const fail: GrpoJobLintFail = {
        ok: false,
        admitted: false,
        jobId,
        subjectId,
        deviceId,
        failureClass: err.obligation,
        detail: err.message,
      };
      cacheGrpoLint(jobId, fail);
      return fail;
    }
    throw err;
  }

  const ok: GrpoJobLintOk = {
    ok: true,
    admitted: true,
    jobId,
    subjectId,
    deviceId,
    sftParentCheckpointHash: parent.checkpointHash,
    corpusManifestHash: declaredHash,
    baseCheckpointHash,
  };

  opts?.onTelemetry?.({
    event: "training.sft_warmstart.grpo_admit",
    outcome: "ok",
    subjectId,
    deviceId,
    jobId,
    checkpointHash: parent.checkpointHash,
    corpusManifestHash: declaredHash,
  });

  cacheGrpoLint(jobId, ok);
  return ok;
}

/**
 * Admit a GRPO job or throw a typed contract error (strict gate).
 */
export function admitGrpoJobOrThrow(
  job: GrpoJobAdmissionRequest,
  opts?: { onTelemetry?: (e: SftWarmstartTelemetryEvent) => void },
): GrpoJobLintOk {
  const result = lintGrpoJobMidTrainAnchor(job, opts);
  if (!result.ok) {
    throw new SftWarmstartContractError(result.detail, {
      obligation: result.failureClass,
      subjectId: result.subjectId,
      deviceId: result.deviceId,
      failingSlice: result.jobId,
    });
  }
  return result;
}

function cacheGrpoLint(jobId: string, result: GrpoJobLintResult): void {
  grpoAdmitCache.set(jobId, result);
  if (grpoAdmitCache.size > GRPO_JOB_LINT_CACHE_LIMIT) {
    const first = grpoAdmitCache.keys().next().value as string | undefined;
    if (first !== undefined) grpoAdmitCache.delete(first);
  }
}

/**
 * Parse a GRPO job admission document (fixture / wire payload).
 */
export function parseGrpoJobAdmissionRequest(
  raw: unknown,
):
  | { ok: true; job: GrpoJobAdmissionRequest }
  | { ok: false; failureClass: SftWarmstartFailureClass; detail: string } {
  if (!raw || typeof raw !== "object") {
    return {
      ok: false,
      failureClass: "sft.schema",
      detail: "GRPO job must be an object",
    };
  }
  const o = raw as Record<string, unknown>;
  if (o.schemaVersion !== GRPO_JOB_SCHEMA_VERSION) {
    return {
      ok: false,
      failureClass: "sft.schema",
      detail: "unsupported GRPO job schemaVersion",
    };
  }
  if (
    typeof o.jobId !== "string" ||
    typeof o.subjectId !== "string" ||
    typeof o.deviceId !== "string" ||
    typeof o.baseCheckpointHash !== "string" ||
    typeof o.declaredCorpusManifestHash !== "string"
  ) {
    return {
      ok: false,
      failureClass: "sft.schema",
      detail: "GRPO job missing required string fields",
    };
  }

  let sftParent: SftAnchoredCheckpoint | null = null;
  if (o.sftParent != null) {
    if (typeof o.sftParent !== "object") {
      return {
        ok: false,
        failureClass: "sft.schema",
        detail: "sftParent must be object or null",
      };
    }
    sftParent = o.sftParent as SftAnchoredCheckpoint;
  }

  const job: GrpoJobAdmissionRequest = {
    schemaVersion: GRPO_JOB_SCHEMA_VERSION,
    jobId: o.jobId,
    subjectId: o.subjectId,
    deviceId: o.deviceId,
    baseCheckpointHash: o.baseCheckpointHash,
    declaredCorpusManifestHash: o.declaredCorpusManifestHash,
    sftParent,
    ...(typeof o.policyCheckpointHash === "string"
      ? { policyCheckpointHash: o.policyCheckpointHash }
      : {}),
  };
  return { ok: true, job };
}

/**
 * CI prove: seeded unanchored-RL fixture must lint red; anchored micro-run admits.
 */
export function proveMidTrainAnchorGateCi(input: {
  fixtureDir: string;
  subjectId?: string;
  deviceId?: string;
  onTelemetry?: (
    e: SftWarmstartTelemetryEvent | CorpusManifestTelemetry,
  ) => void;
}): {
  ok: true;
  violationRejected: true;
  violationFailureClass: SftWarmstartFailureClass;
  anchoredAdmitted: true;
} {
  const subjectId = input.subjectId ?? "subj.sft.gate";
  const deviceId = input.deviceId ?? "dev.sft.gate";

  const violationPath = path.join(
    input.fixtureDir,
    SFT_ANCHOR_GATE_VIOLATION_UNANCHORED,
  );
  const raw = JSON.parse(readFileSync(violationPath, "utf8")) as unknown;
  const parsed = parseGrpoJobAdmissionRequest(raw);
  if (!parsed.ok) {
    throw new SftWarmstartContractError(parsed.detail, {
      obligation: parsed.failureClass,
      subjectId,
    });
  }

  resetGrpoAdmitCache();
  const linted = lintGrpoJobMidTrainAnchor(parsed.job, {
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });
  if (linted.ok || linted.failureClass !== "sft.unanchored_grpo") {
    throw new SftWarmstartContractError(
      `expected unanchored fixture to fail sft.unanchored_grpo, got ${
        linted.ok ? "admitted" : linted.failureClass
      }`,
      { obligation: "sft.schema", subjectId },
    );
  }

  resetSftWarmstartCache();
  resetGrpoAdmitCache();
  const warm = proveSftWarmstartMicroRun({
    subjectId,
    deviceId,
    baseCheckpointHash: "ckpt:sha256:sftgatebase012345678",
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });

  const admitted = lintGrpoJobMidTrainAnchor(
    {
      schemaVersion: GRPO_JOB_SCHEMA_VERSION,
      jobId: "grpo.anchored.micro",
      subjectId,
      deviceId,
      baseCheckpointHash: warm.checkpoint.baseCheckpointHash,
      declaredCorpusManifestHash: warm.corpusManifestHash,
      sftParent: warm.checkpoint,
    },
    {
      ...(input.onTelemetry !== undefined
        ? { onTelemetry: input.onTelemetry }
        : {}),
    },
  );
  if (!admitted.ok) {
    throw new SftWarmstartContractError(
      `anchored micro GRPO should admit: ${admitted.detail}`,
      { obligation: admitted.failureClass, subjectId },
    );
  }

  return {
    ok: true,
    violationRejected: true,
    violationFailureClass: linted.failureClass,
    anchoredAdmitted: true,
  };
}

/** Test helper — clear GRPO admission lint cache. */
export function resetGrpoAdmitCache(): void {
  grpoAdmitCache.clear();
}
