/**
 * Obligation registry surface (Track B B0).
 *
 * Obligation IDs are append-only once published; renames are deprecations.
 * Every registered obligation MUST carry the verbatim MUST sentence from
 * `@moolam/contracts` doc comments (not a paraphrase).
 *
 * Registration with duplicate-ID rejection, grouping by
 * contract, and JSON catalog export for docs + Track A sync_audit
 * violation-class logging (M-point). Runner deadlines land in RUNNCORE.
 */

/** Structured event — never includes raw learner/user content. */
export interface ConformanceObligationEvent {
  event: "conformance.obligation";
  obligationId: string;
  outcome: "pass" | "fail" | "error";
  subjectId: string;
  deviceId?: string;
  contract?: string;
}

/** Registry lifecycle events (distinct failure classes; no silent swallow). */
export interface ConformanceRegistryEvent {
  event: "conformance.registry";
  outcome: "registered" | "duplicate_rejected" | "unknown_selection";
  obligationId: string;
  contract?: string;
}

export type ConformanceEvent =
  | ConformanceObligationEvent
  | ConformanceRegistryEvent;

/**
 * Catalog row for docs and Track A `sync_audit` violation-class logging.
 * Omits the executable `check` — catalog is metadata only.
 */
export interface ObligationCatalogEntry {
  id: string;
  contract: string;
  mustText: string;
  specIds: string[];
  /** Stable violation class (== obligation id once published). */
  violationClass: string;
}

export interface ObligationCatalog {
  kind: "obligation-catalog";
  /** Append-only public surface — bump only when catalog schema evolves. */
  catalogVersion: "1.0.0";
  obligations: ObligationCatalogEntry[];
}

/** Duplicate registration — IDs are append-only; never overwrite. */
export class DuplicateObligationIdError extends Error {
  readonly obligationId: string;

  constructor(obligationId: string) {
    super(
      `obligation id '${obligationId}' is already registered (append-only; renames are deprecations)`,
    );
    this.name = "DuplicateObligationIdError";
    this.obligationId = obligationId;
  }
}

/** Selection referenced an id that was never registered. */
export class UnknownObligationIdError extends Error {
  readonly obligationId: string;

  constructor(obligationId: string) {
    super(`unknown obligation id '${obligationId}'`);
    this.name = "UnknownObligationIdError";
    this.obligationId = obligationId;
  }
}

/**
 * Per-check isolation context. Fresh per obligation invocation.
 * All reads/writes inside a check are scoped by `subjectId`.
 */
export interface ObligationContext {
  /** Subject under test — cross-subject leakage is a failed obligation. */
  readonly subjectId: string;
  /** Optional device id for observability correlation only. */
  readonly deviceId: string | undefined;
  /**
   * Wall-clock budget for this obligation (ms). A hanging implementation
   * must fail at this deadline — the runner never hangs (RUNNCORE).
   */
  readonly deadlineMs: number;
  /** Abort signal tied to the deadline (or external cancel). */
  readonly signal: AbortSignal;
  /** Emit a structured verdict/progress event (no plaintext content). */
  emit(event: ConformanceObligationEvent): void;
}

/**
 * One executable MUST clause. Generic over the contract surface under test.
 */
export interface Obligation<T> {
  /** Stable id, e.g. `"CK-02.1"` (memory durability). Append-only once published. */
  id: string;
  /** Contract surface name, e.g. `"MemoryInterface"`. */
  contract: string;
  /** Verbatim MUST sentence from `@moolam/contracts` doc comments. */
  mustText: string;
  /** PRD_MATRIX / public-spec row crosswalk, e.g. `["MCE-03"]`. */
  specIds: readonly string[];
  /** Throw {@link ObligationViolation} to fail; resolve to pass. */
  check(impl: T, ctx: ObligationContext): Promise<void>;
}

/** Typed failure of a single obligation — not a harness crash. */
export class ObligationViolation extends Error {
  readonly obligationId: string;
  readonly mustText: string;
  readonly contract: string;

  constructor(args: {
    obligationId: string;
    mustText: string;
    contract: string;
    message: string;
    cause?: unknown;
  }) {
    super(
      args.message,
      args.cause !== undefined ? { cause: args.cause } : undefined,
    );
    this.name = "ObligationViolation";
    this.obligationId = args.obligationId;
    this.mustText = args.mustText;
    this.contract = args.contract;
  }
}

export type CreateObligationContextParams = {
  subjectId: string;
  deadlineMs?: number;
  signal?: AbortSignal;
  emit?: (event: ConformanceObligationEvent) => void;
} & (
  | { deviceId: string }
  | { deviceId?: undefined }
);

/**
 * Build an isolated {@link ObligationContext}.
 * Requires a non-empty `subjectId` (sovereignty / subject isolation).
 */
export function createObligationContext(
  params: CreateObligationContextParams,
): ObligationContext {
  const subjectId = params.subjectId.trim();
  if (!subjectId) {
    throw new Error(
      "ObligationContext.subjectId is required (subject isolation)",
    );
  }
  const deadlineMs = params.deadlineMs ?? 5_000;
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    throw new Error("ObligationContext.deadlineMs must be a positive number");
  }
  // Default is silent; suites/runner inject structured emitters (stdout/CI).
  const emit = params.emit ?? ((_event: ConformanceObligationEvent) => {});

  return {
    subjectId,
    deviceId: params.deviceId,
    deadlineMs,
    signal: params.signal ?? new AbortController().signal,
    emit,
  };
}

/**
 * Freeze and validate obligation metadata at definition time.
 */
export function defineObligation<T>(obligation: Obligation<T>): Obligation<T> {
  const id = obligation.id.trim();
  const contract = obligation.contract.trim();
  const mustText = obligation.mustText.trim();
  if (!id) throw new Error("obligation.id is required");
  if (!contract) throw new Error("obligation.contract is required");
  if (!mustText) {
    throw new Error(
      "obligation.mustText must carry the verbatim MUST sentence from @moolam/contracts",
    );
  }
  if (!/\bMUST\b/.test(mustText)) {
    throw new Error(
      "obligation.mustText must include the verbatim MUST keyword from @moolam/contracts",
    );
  }
  if (!Array.isArray(obligation.specIds) || obligation.specIds.length === 0) {
    throw new Error("obligation.specIds must list at least one PRD_MATRIX row");
  }

  return Object.freeze({
    id,
    contract,
    mustText,
    specIds: Object.freeze([...obligation.specIds]) as readonly string[],
    check: obligation.check,
  });
}

export type ObligationRegistryOptions = {
  /** Injected emitter for register/select outcomes (no raw content). */
  emit?: (event: ConformanceRegistryEvent) => void;
};

/**
 * Append-only obligation catalog. Registration rejects duplicate IDs;
 * grouping and JSON export support docs and sync_audit violation classes.
 */
export class ObligationRegistry {
  private readonly byId = new Map<string, Obligation<unknown>>();
  private readonly emit: (event: ConformanceRegistryEvent) => void;

  constructor(options: ObligationRegistryOptions = {}) {
    this.emit = options.emit ?? ((_event: ConformanceRegistryEvent) => {});
  }

  /** Number of registered obligations (bounded by suite size, not a scan). */
  get size(): number {
    return this.byId.size;
  }

  has(id: string): boolean {
    return this.byId.has(id.trim());
  }

  get(id: string): Obligation<unknown> | undefined {
    return this.byId.get(id.trim());
  }

  /**
   * Register an obligation. Duplicate ids throw
   * {@link DuplicateObligationIdError} — never overwrite (append-only).
   */
  register<T>(obligation: Obligation<T>): Obligation<T> {
    const defined = defineObligation(obligation);
    if (this.byId.has(defined.id)) {
      this.emit({
        event: "conformance.registry",
        outcome: "duplicate_rejected",
        obligationId: defined.id,
        contract: defined.contract,
      });
      throw new DuplicateObligationIdError(defined.id);
    }
    this.byId.set(defined.id, defined as Obligation<unknown>);
    this.emit({
      event: "conformance.registry",
      outcome: "registered",
      obligationId: defined.id,
      contract: defined.contract,
    });
    return defined;
  }

  /** Registration-order snapshot of all obligations. */
  list(): readonly Obligation<unknown>[] {
    return [...this.byId.values()];
  }

  /** Sorted unique ids (stable public surface). */
  listIds(): readonly string[] {
    return [...this.byId.keys()].sort();
  }

  /**
   * Select obligations by id. Empty `ids` → all (sorted by id).
   * Unknown id → {@link UnknownObligationIdError}.
   */
  select(ids?: readonly string[]): Obligation<unknown>[] {
    if (ids === undefined || ids.length === 0) {
      return this.listIds().map((id) => this.byId.get(id)!);
    }
    const out: Obligation<unknown>[] = [];
    for (const raw of ids) {
      const id = raw.trim();
      const obl = this.byId.get(id);
      if (!obl) {
        this.emit({
          event: "conformance.registry",
          outcome: "unknown_selection",
          obligationId: id,
        });
        throw new UnknownObligationIdError(id);
      }
      out.push(obl);
    }
    return out;
  }

  /**
   * Group catalog metadata by contract name (keys sorted; entries by id).
   */
  groupByContract(): ReadonlyMap<string, readonly ObligationCatalogEntry[]> {
    const grouped = new Map<string, ObligationCatalogEntry[]>();
    for (const entry of this.toCatalog().obligations) {
      const bucket = grouped.get(entry.contract);
      if (bucket) bucket.push(entry);
      else grouped.set(entry.contract, [entry]);
    }
    const sorted = new Map<string, readonly ObligationCatalogEntry[]>();
    for (const contract of [...grouped.keys()].sort()) {
      const rows = grouped.get(contract)!;
      rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      sorted.set(contract, rows);
    }
    return sorted;
  }

  /** Metadata catalog (no `check` functions) for docs / sync_audit. */
  toCatalog(): ObligationCatalog {
    const obligations = this.listIds().map((id) => {
      const obl = this.byId.get(id)!;
      const entry: ObligationCatalogEntry = {
        id: obl.id,
        contract: obl.contract,
        mustText: obl.mustText,
        specIds: [...obl.specIds],
        violationClass: obl.id,
      };
      return entry;
    });
    return {
      kind: "obligation-catalog",
      catalogVersion: "1.0.0",
      obligations,
    };
  }

  /**
   * Stable JSON for docs and Track A sync_audit violation-class logging.
   * Key order is insertion order from {@link toCatalog}.
   */
  exportCatalogJson(): string {
    return `${JSON.stringify(this.toCatalog(), null, 2)}\n`;
  }

  /** Distinct violation classes (== published obligation ids). */
  violationClasses(): readonly string[] {
    return this.listIds();
  }
}

/**
 * Invoke a single obligation against an impl (scaffold helper for suite tests).
 * Attributes thrown {@link ObligationViolation} unchanged; wraps unexpected
 * errors so callers can distinguish implementor faults from harness faults later.
 */
export async function invokeObligation<T>(
  obligation: Obligation<T>,
  impl: T,
  ctx: ObligationContext,
): Promise<void> {
  try {
    await obligation.check(impl, ctx);
    ctx.emit({
      event: "conformance.obligation",
      obligationId: obligation.id,
      outcome: "pass",
      subjectId: ctx.subjectId,
      ...(ctx.deviceId !== undefined ? { deviceId: ctx.deviceId } : {}),
      contract: obligation.contract,
    });
  } catch (err) {
    if (err instanceof ObligationViolation) {
      ctx.emit({
        event: "conformance.obligation",
        obligationId: obligation.id,
        outcome: "fail",
        subjectId: ctx.subjectId,
        ...(ctx.deviceId !== undefined ? { deviceId: ctx.deviceId } : {}),
        contract: obligation.contract,
      });
      throw err;
    }
    ctx.emit({
      event: "conformance.obligation",
      obligationId: obligation.id,
      outcome: "error",
      subjectId: ctx.subjectId,
      ...(ctx.deviceId !== undefined ? { deviceId: ctx.deviceId } : {}),
      contract: obligation.contract,
    });
    throw new ObligationViolation({
      obligationId: obligation.id,
      mustText: obligation.mustText,
      contract: obligation.contract,
      message: `unexpected error during obligation ${obligation.id}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      cause: err,
    });
  }
}
