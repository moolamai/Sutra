/**
 * B5 degradation registry — load/validate the A P6 contract and expose a
 * host-facing register() / resolve API.
 *
 * Behavior enum (task surface): `stale_with_marker` | `queue` | `hard_stop`
 * maps onto A P6 modes STALE_READ / QUEUE_AND_WARN / HARD_STOP_WRITE.
 *
 * Reads → last-known-good with freshness marker when degraded.
 * Writes → hard-stop with rollback — never silent retry.
 * Unknown dependency → default hard_stop (block), never passthrough.
 * Never fabricate data in production adapters.
 *
 * Sovereignty: telemetry carries subjectId / deviceId / outcome — never
 * learner content or fabricated reply bodies.
 */

import {
  DEGRADATION_MODES,
  DEGRADATION_OPERATIONS,
  DEGRADATION_SURFACES,
  type DegradationBehaviorSpec,
  type DegradationMode,
  type DegradationOperation,
  type DegradationSurface,
} from "@moolam/contracts";
import {
  DEFAULT_DEGRADATION_REGISTRY,
  assertStaleReadPayload,
  createDegradationRegistry,
  degradationRegistryDocumentSchema,
  type DegradationRegistryDocument,
  type DegradationRegistryHandle,
  type FreshnessMarker,
} from "@moolam/sync-protocol";

/** Soft cap on host-registered dependency aliases (NFR — no unbounded map). */
export const DEGRADATION_DEPENDENCY_REGISTER_LIMIT = 64;

/** Soft cap on dependency name length. */
export const DEGRADATION_DEPENDENCY_NAME_LIMIT = 64;

/**
 * Host-facing behavior enum (product language for adapter wiring).
 * Maps 1:1 onto A P6 DegradationMode.
 */
export const DEGRADATION_BEHAVIORS = Object.freeze([
  "stale_with_marker",
  "queue",
  "hard_stop",
] as const);

export type DegradationBehavior = (typeof DEGRADATION_BEHAVIORS)[number];

/** Relative path to the A P6 default registry fixture (monorepo). */
export const A_P6_DEGRADATION_REGISTRY_FIXTURE_RELPATH =
  "packages/sync-protocol/fixtures/degradation-registry/default-registry.json" as const;

export type DegradationRegistryFailureClass =
  | "missing_subject"
  | "cross_subject"
  | "schema_violation"
  | "invalid_behavior"
  | "invalid_dependency"
  | "section_limit"
  | "conflict"
  | "unknown_dependency";

export type DegradationRegistryTelemetryEvent = {
  event: "runtime.harness.degradation_registry";
  outcome: "ok" | "rejected" | "advisory";
  subjectId: string | null;
  deviceId?: string;
  action?: "load" | "validate" | "register" | "resolve" | "lookup" | "invoke";
  dependency?: string;
  behavior?: DegradationBehavior;
  mode?: DegradationMode;
  surface?: DegradationSurface;
  operation?: DegradationOperation;
  signalCode?: string;
  defaultedHardStop?: boolean;
  registryVersion?: string;
  bindingCount?: number;
  failureClass?: DegradationRegistryFailureClass;
  /** Distinct advisory outcome when a call site is degraded. */
  advisoryOutcome?: DegradationAdvisoryOutcome;
  rolledBack?: boolean;
  queued?: boolean;
  silentWriteRetry?: false;
  fabricated?: false;
};

/** Well-known adapter invoke sites that consult the registry on failure. */
export const DEGRADATION_WIRE_DEPENDENCIES = Object.freeze([
  "model",
  "sync",
  "tool",
] as const);

export type DegradationWireDependency =
  (typeof DEGRADATION_WIRE_DEPENDENCIES)[number];

export type DegradationAdvisoryOutcome =
  | "stale_served"
  | "hard_stopped"
  | "queued"
  | "blocked_no_lkg";

/**
 * Structured advisory from a degraded invoke — metadata only, never content.
 */
export type DegradationAdvisorySignal = {
  event: "runtime.harness.degradation_advisory";
  subjectId: string;
  deviceId?: string;
  dependency: string;
  operation: DegradationOperation;
  behavior: DegradationBehavior;
  mode: DegradationMode;
  signalCode: string;
  outcome: DegradationAdvisoryOutcome;
  silentWriteRetry: false;
  fabricated: false;
  rolledBack?: boolean;
  queued?: boolean;
};

const MODE_TO_BEHAVIOR: Record<DegradationMode, DegradationBehavior> = {
  STALE_READ: "stale_with_marker",
  QUEUE_AND_WARN: "queue",
  HARD_STOP_WRITE: "hard_stop",
};

const BEHAVIOR_TO_MODE: Record<DegradationBehavior, DegradationMode> = {
  stale_with_marker: "STALE_READ",
  queue: "QUEUE_AND_WARN",
  hard_stop: "HARD_STOP_WRITE",
};

/** Default A P6 surface for a well-known dependency name. */
const DEPENDENCY_TO_SURFACE: Record<string, DegradationSurface> = {
  model: "model",
  sync: "sync",
  storage: "storage",
  // Tool is not an A P6 surface — resolve defaults to hard_stop unless registered.
};

export function degradationModeToBehavior(
  mode: DegradationMode,
): DegradationBehavior {
  return MODE_TO_BEHAVIOR[mode];
}

export function degradationBehaviorToMode(
  behavior: DegradationBehavior,
): DegradationMode {
  return BEHAVIOR_TO_MODE[behavior];
}

export function isDegradationBehavior(
  value: unknown,
): value is DegradationBehavior {
  return (
    typeof value === "string" &&
    (DEGRADATION_BEHAVIORS as readonly string[]).includes(value)
  );
}

export type LoadDegradationRegistryAccepted = {
  ok: true;
  registry: RuntimeDegradationRegistry;
  registryVersion: string;
  bindingCount: number;
  subjectId: string | null;
};

export type LoadDegradationRegistryRejected = {
  ok: false;
  failureClass: DegradationRegistryFailureClass;
  subjectId: string | null;
  detail: string;
};

export type LoadDegradationRegistryResult =
  | LoadDegradationRegistryAccepted
  | LoadDegradationRegistryRejected;

export type LoadDegradationRegistryOptions = {
  /** Raw A P6 document (defaults to SDK-shipped DEFAULT_DEGRADATION_REGISTRY). */
  document?: unknown;
  subjectId?: string;
  deviceId?: string;
  onTelemetry?: (event: DegradationRegistryTelemetryEvent) => void;
};

/**
 * Parse and validate an A P6 DegradationRegistry document, then wrap it in
 * {@link RuntimeDegradationRegistry} with register() / resolve().
 */
export function loadDegradationRegistry(
  options: LoadDegradationRegistryOptions = {},
): LoadDegradationRegistryResult {
  const onTelemetry = options.onTelemetry;
  const subjectId =
    typeof options.subjectId === "string" && options.subjectId.trim()
      ? options.subjectId.trim()
      : null;

  const raw = options.document ?? DEFAULT_DEGRADATION_REGISTRY;
  const parsed = degradationRegistryDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    const detail =
      parsed.error.issues[0]?.message ?? "DegradationRegistry schema_violation";
    onTelemetry?.({
      event: "runtime.harness.degradation_registry",
      outcome: "rejected",
      subjectId,
      ...(options.deviceId !== undefined
        ? { deviceId: options.deviceId }
        : {}),
      action: "validate",
      failureClass: "schema_violation",
    });
    return {
      ok: false,
      failureClass: "schema_violation",
      subjectId,
      detail,
    };
  }

  let handle: DegradationRegistryHandle;
  try {
    handle = createDegradationRegistry(parsed.data);
  } catch (err) {
    return {
      ok: false,
      failureClass: "schema_violation",
      subjectId,
      detail: err instanceof Error ? err.message : "createDegradationRegistry failed",
    };
  }

  // Invariant check: A P6 modes must never allow fabrication / silent write retry.
  for (const mode of DEGRADATION_MODES) {
    const spec = handle.document.modes[mode];
    if (spec.allowsFabrication !== false || spec.allowsSilentWriteRetry !== false) {
      onTelemetry?.({
        event: "runtime.harness.degradation_registry",
        outcome: "rejected",
        subjectId,
        action: "validate",
        mode,
        failureClass: "schema_violation",
      });
      return {
        ok: false,
        failureClass: "schema_violation",
        subjectId,
        detail: `mode ${mode} must forbid fabrication and silent write retry`,
      };
    }
  }

  const registry = new RuntimeDegradationRegistry(handle, {
    ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
    ...(onTelemetry !== undefined ? { onTelemetry } : {}),
  });

  onTelemetry?.({
    event: "runtime.harness.degradation_registry",
    outcome: "ok",
    subjectId,
    ...(options.deviceId !== undefined
      ? { deviceId: options.deviceId }
      : {}),
    action: "load",
    registryVersion: handle.document.version,
    bindingCount: handle.document.bindings.length,
  });

  return {
    ok: true,
    registry,
    registryVersion: handle.document.version,
    bindingCount: handle.document.bindings.length,
    subjectId,
  };
}

export type RegisterDegradationAccepted = {
  ok: true;
  dependency: string;
  behavior: DegradationBehavior;
  mode: DegradationMode;
  subjectId: string;
  deviceId?: string;
  idempotent?: boolean;
};

export type RegisterDegradationRejected = {
  ok: false;
  failureClass: DegradationRegistryFailureClass;
  subjectId: string | null;
  deviceId?: string;
  detail: string;
};

export type RegisterDegradationResult =
  | RegisterDegradationAccepted
  | RegisterDegradationRejected;

export type ResolveDegradationAccepted = {
  ok: true;
  dependency: string;
  operation: DegradationOperation;
  behavior: DegradationBehavior;
  mode: DegradationMode;
  signalCode: string;
  spec: DegradationBehaviorSpec;
  subjectId: string;
  deviceId?: string;
  /** True when unknown dependency fell through to hard_stop (not passthrough). */
  defaultedHardStop: boolean;
  allowsFabrication: false;
  allowsSilentWriteRetry: false;
};

export type ResolveDegradationRejected = {
  ok: false;
  failureClass: DegradationRegistryFailureClass;
  subjectId: string | null;
  deviceId?: string;
  detail: string;
};

export type ResolveDegradationResult =
  | ResolveDegradationAccepted
  | ResolveDegradationRejected;

/**
 * Host registry: validated A P6 document + dependency register() overlays.
 * Does not mutate the SDK-shipped A P6 mode table per tenant.
 */
export class RuntimeDegradationRegistry {
  readonly document: DegradationRegistryDocument;
  private readonly handle: DegradationRegistryHandle;
  private readonly overlays = new Map<string, DegradationBehavior>();
  private readonly deviceId: string | undefined;
  private readonly onTelemetry:
    | ((event: DegradationRegistryTelemetryEvent) => void)
    | undefined;

  constructor(
    handle: DegradationRegistryHandle,
    options: {
      deviceId?: string;
      onTelemetry?: (event: DegradationRegistryTelemetryEvent) => void;
    } = {},
  ) {
    this.handle = handle;
    this.document = handle.document;
    this.deviceId =
      options.deviceId !== undefined ? options.deviceId : undefined;
    this.onTelemetry = options.onTelemetry;
  }

  /** Registered dependency → behavior overlays (read-only snapshot). */
  listRegistrations(): ReadonlyArray<{
    dependency: string;
    behavior: DegradationBehavior;
  }> {
    return [...this.overlays.entries()].map(([dependency, behavior]) => ({
      dependency,
      behavior,
    }));
  }

  /**
   * Register a dependency name → host Behavior.
   * Idempotent when the same behavior is re-registered; conflicting
   * re-register is rejected (not last-write-wins).
   */
  register(
    dependency: string,
    behavior: DegradationBehavior,
    opts: { subjectId: string },
  ): RegisterDegradationResult {
    const subjectId = trimStr(opts.subjectId);
    if (!subjectId) {
      this.onTelemetry?.({
        event: "runtime.harness.degradation_registry",
        outcome: "rejected",
        subjectId: null,
        action: "register",
        failureClass: "missing_subject",
      });
      return {
        ok: false,
        failureClass: "missing_subject",
        subjectId: null,
        detail: "subjectId required",
      };
    }

    const dep = trimStr(dependency).toLowerCase();
    if (!dep) {
      return {
        ok: false,
        failureClass: "invalid_dependency",
        subjectId,
        detail: "dependency name required",
      };
    }
    if (dep.length > DEGRADATION_DEPENDENCY_NAME_LIMIT) {
      return {
        ok: false,
        failureClass: "section_limit",
        subjectId,
        detail: `dependency name exceeds ${DEGRADATION_DEPENDENCY_NAME_LIMIT}`,
      };
    }
    if (!isDegradationBehavior(behavior)) {
      return {
        ok: false,
        failureClass: "invalid_behavior",
        subjectId,
        detail: "behavior must be stale_with_marker | queue | hard_stop",
      };
    }

    const existing = this.overlays.get(dep);
    if (existing !== undefined) {
      if (existing === behavior) {
        this.onTelemetry?.({
          event: "runtime.harness.degradation_registry",
          outcome: "ok",
          subjectId,
          ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
          action: "register",
          dependency: dep,
          behavior,
          mode: degradationBehaviorToMode(behavior),
        });
        return {
          ok: true,
          dependency: dep,
          behavior,
          mode: degradationBehaviorToMode(behavior),
          subjectId,
          ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
          idempotent: true,
        };
      }
      this.onTelemetry?.({
        event: "runtime.harness.degradation_registry",
        outcome: "rejected",
        subjectId,
        action: "register",
        dependency: dep,
        failureClass: "conflict",
      });
      return {
        ok: false,
        failureClass: "conflict",
        subjectId,
        detail: `dependency '${dep}' already registered as ${existing}`,
      };
    }

    if (this.overlays.size >= DEGRADATION_DEPENDENCY_REGISTER_LIMIT) {
      return {
        ok: false,
        failureClass: "section_limit",
        subjectId,
        detail: `dependency register limit ${DEGRADATION_DEPENDENCY_REGISTER_LIMIT}`,
      };
    }

    this.overlays.set(dep, behavior);
    const mode = degradationBehaviorToMode(behavior);
    this.onTelemetry?.({
      event: "runtime.harness.degradation_registry",
      outcome: "ok",
      subjectId,
      ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
      action: "register",
      dependency: dep,
      behavior,
      mode,
      signalCode: this.document.modes[mode].signalCode,
    });
    return {
      ok: true,
      dependency: dep,
      behavior,
      mode,
      subjectId,
      ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
    };
  }

  /**
   * Resolve behavior for a dependency failure.
   * Overlay register() wins; else A P6 surface binding; else hard_stop.
   */
  resolve(input: {
    dependency: string;
    operation: DegradationOperation;
    subjectId: string;
    deviceId?: string;
  }): ResolveDegradationResult {
    const subjectId = trimStr(input.subjectId);
    const deviceId =
      input.deviceId !== undefined ? input.deviceId : this.deviceId;
    if (!subjectId) {
      this.onTelemetry?.({
        event: "runtime.harness.degradation_registry",
        outcome: "rejected",
        subjectId: null,
        action: "resolve",
        failureClass: "missing_subject",
      });
      return {
        ok: false,
        failureClass: "missing_subject",
        subjectId: null,
        detail: "subjectId required",
      };
    }

    if (
      !(DEGRADATION_OPERATIONS as readonly string[]).includes(input.operation)
    ) {
      return {
        ok: false,
        failureClass: "schema_violation",
        subjectId,
        detail: "operation must be read | write",
      };
    }

    const dep = trimStr(input.dependency).toLowerCase();
    if (!dep) {
      return {
        ok: false,
        failureClass: "invalid_dependency",
        subjectId,
        detail: "dependency name required",
      };
    }

    const overlay = this.overlays.get(dep);
    if (overlay !== undefined) {
      const mode = degradationBehaviorToMode(overlay);
      const spec = this.document.modes[mode];
      this.emitResolveOk({
        subjectId,
        ...(deviceId !== undefined ? { deviceId } : {}),
        dependency: dep,
        operation: input.operation,
        behavior: overlay,
        mode,
        spec,
        defaultedHardStop: false,
      });
      return {
        ok: true,
        dependency: dep,
        operation: input.operation,
        behavior: overlay,
        mode,
        signalCode: spec.signalCode,
        spec,
        subjectId,
        ...(deviceId !== undefined ? { deviceId } : {}),
        defaultedHardStop: false,
        allowsFabrication: false,
        allowsSilentWriteRetry: false,
      };
    }

    const surface = DEPENDENCY_TO_SURFACE[dep];
    if (surface !== undefined) {
      const looked = this.handle.lookup(surface, input.operation, {
        subjectId,
        ...(deviceId !== undefined ? { deviceId } : {}),
      });
      if (looked.outcome === "accepted") {
        const behavior = degradationModeToBehavior(looked.behavior.mode);
        this.emitResolveOk({
          subjectId,
          ...(deviceId !== undefined ? { deviceId } : {}),
          dependency: dep,
          operation: input.operation,
          behavior,
          mode: looked.behavior.mode,
          spec: looked.behavior,
          defaultedHardStop: false,
          surface,
        });
        return {
          ok: true,
          dependency: dep,
          operation: input.operation,
          behavior,
          mode: looked.behavior.mode,
          signalCode: looked.behavior.signalCode,
          spec: looked.behavior,
          subjectId,
          ...(deviceId !== undefined ? { deviceId } : {}),
          defaultedHardStop: false,
          allowsFabrication: false,
          allowsSilentWriteRetry: false,
        };
      }
    }

    // Unknown dependency → default hard_stop (block), never passthrough.
    const mode: DegradationMode = "HARD_STOP_WRITE";
    const spec = this.document.modes[mode];
    const behavior: DegradationBehavior = "hard_stop";
    this.onTelemetry?.({
      event: "runtime.harness.degradation_registry",
      outcome: "advisory",
      subjectId,
      ...(deviceId !== undefined ? { deviceId } : {}),
      action: "resolve",
      dependency: dep,
      operation: input.operation,
      behavior,
      mode,
      signalCode: spec.signalCode,
      defaultedHardStop: true,
      failureClass: "unknown_dependency",
    });
    return {
      ok: true,
      dependency: dep,
      operation: input.operation,
      behavior,
      mode,
      signalCode: spec.signalCode,
      spec,
      subjectId,
      ...(deviceId !== undefined ? { deviceId } : {}),
      defaultedHardStop: true,
      allowsFabrication: false,
      allowsSilentWriteRetry: false,
    };
  }

  /**
   * Thin A P6 surface lookup (no dependency overlay). Unknown binding →
   * hard_stop default (block).
   */
  lookupSurface(
    surface: DegradationSurface,
    operation: DegradationOperation,
    opts: { subjectId: string; deviceId?: string },
  ): ResolveDegradationResult {
    const subjectId = trimStr(opts.subjectId);
    if (!subjectId) {
      return {
        ok: false,
        failureClass: "missing_subject",
        subjectId: null,
        detail: "subjectId required",
      };
    }
    if (!(DEGRADATION_SURFACES as readonly string[]).includes(surface)) {
      return this.resolve({
        dependency: `unknown-surface:${String(surface)}`,
        operation,
        subjectId,
        ...(opts.deviceId !== undefined ? { deviceId: opts.deviceId } : {}),
      });
    }
    const looked = this.handle.lookup(surface, operation, {
      subjectId,
      ...(opts.deviceId !== undefined ? { deviceId: opts.deviceId } : {}),
    });
    if (looked.outcome !== "accepted") {
      const mode: DegradationMode = "HARD_STOP_WRITE";
      const spec = this.document.modes[mode];
      return {
        ok: true,
        dependency: surface,
        operation,
        behavior: "hard_stop",
        mode,
        signalCode: spec.signalCode,
        spec,
        subjectId,
        ...(opts.deviceId !== undefined ? { deviceId: opts.deviceId } : {}),
        defaultedHardStop: true,
        allowsFabrication: false,
        allowsSilentWriteRetry: false,
      };
    }
    const behavior = degradationModeToBehavior(looked.behavior.mode);
    return {
      ok: true,
      dependency: surface,
      operation,
      behavior,
      mode: looked.behavior.mode,
      signalCode: looked.behavior.signalCode,
      spec: looked.behavior,
      subjectId,
      ...(opts.deviceId !== undefined ? { deviceId: opts.deviceId } : {}),
      defaultedHardStop: false,
      allowsFabrication: false,
      allowsSilentWriteRetry: false,
    };
  }

  private emitResolveOk(input: {
    subjectId: string;
    deviceId?: string;
    dependency: string;
    operation: DegradationOperation;
    behavior: DegradationBehavior;
    mode: DegradationMode;
    spec: DegradationBehaviorSpec;
    defaultedHardStop: boolean;
    surface?: DegradationSurface;
  }): void {
    this.onTelemetry?.({
      event: "runtime.harness.degradation_registry",
      outcome: "ok",
      subjectId: input.subjectId,
      ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      action: "resolve",
      dependency: input.dependency,
      operation: input.operation,
      behavior: input.behavior,
      mode: input.mode,
      signalCode: input.spec.signalCode,
      defaultedHardStop: input.defaultedHardStop,
      ...(input.surface !== undefined ? { surface: input.surface } : {}),
    });
  }

  /**
   * Wire an adapter invoke through the registry: one attempt, then
   * stale / queue / hard_stop — never silent write retry or fabrication.
   */
  invoke<T>(
    options: Omit<InvokeWithDegradationOptions<T>, "registry">,
  ): Promise<InvokeWithDegradationResult<T>> {
    return invokeWithDegradation({ ...options, registry: this });
  }
}

export type InvokeWithDegradationOptions<T> = {
  registry: RuntimeDegradationRegistry;
  dependency: DegradationWireDependency | string;
  operation: DegradationOperation;
  subjectId: string;
  deviceId?: string;
  /** Single dependency call — never auto-retried after failure. */
  invoke: () => Promise<T> | T;
  /**
   * Last-known-good for `stale_with_marker` reads. Never fabricated;
   * absent → hard-stop (block), not invented data.
   */
  lastKnownGood?: T;
  /** Opaque capture time (ISO/HLC) for the freshness marker — required with LKG. */
  capturedAt?: string;
  freshnessSource?: FreshnessMarker["source"];
  /** Compensate uncommitted write effects — at most once per failed invoke. */
  rollback?: () => void | Promise<void>;
  /** Queue path for `queue` behavior — never silent catch-and-continue. */
  enqueue?: (entry: {
    dependency: string;
    operation: DegradationOperation;
    subjectId: string;
    signalCode: string;
  }) => void | Promise<void>;
  onTelemetry?: (event: DegradationRegistryTelemetryEvent) => void;
  onAdvisory?: (signal: DegradationAdvisorySignal) => void;
};

export type InvokeWithDegradationResult<T> =
  | {
      ok: true;
      degraded: false;
      value: T;
      subjectId: string;
      dependency: string;
      operation: DegradationOperation;
      /** Always 1 on success — proves no silent retry loop. */
      invokeCount: 1;
    }
  | {
      ok: true;
      degraded: true;
      behavior: "stale_with_marker";
      value: T;
      freshnessMarker: FreshnessMarker;
      fabricated: false;
      silentWriteRetry: false;
      signalCode: string;
      advisory: DegradationAdvisorySignal;
      subjectId: string;
      dependency: string;
      operation: DegradationOperation;
      invokeCount: 1;
      /** Shape accepted by A P6 `assertStaleReadPayload`. */
      payload: {
        value: T;
        freshnessMarker: FreshnessMarker;
        fabricated: false;
      };
    }
  | {
      ok: false;
      degraded: true;
      behavior: DegradationBehavior;
      failureClass:
        | "dependency_failure"
        | "missing_last_known_good"
        | "write_hard_stopped"
        | "queued"
        | "missing_subject"
        | "schema_violation"
        | "invalid_dependency";
      fabricated: false;
      silentWriteRetry: false;
      signalCode: string;
      advisory: DegradationAdvisorySignal | null;
      rolledBack: boolean;
      queued: boolean;
      subjectId: string | null;
      dependency: string;
      operation: DegradationOperation;
      invokeCount: 0 | 1;
      detail: string;
    };

/**
 * Wrap a model / sync / tool (or other) invoke: on success return the value;
 * on failure consult the registry and apply stale / queue / hard_stop.
 *
 * Invariants:
 * - One invoke attempt only — never silent write retry.
 * - Stale reads require last-known-good + freshness marker — never fabricate.
 * - Writes hard-stop (rollback) or queue with an advisory — never proceed.
 */
export async function invokeWithDegradation<T>(
  options: InvokeWithDegradationOptions<T>,
): Promise<InvokeWithDegradationResult<T>> {
  const subjectId = trimStr(options.subjectId);
  const dependency = trimStr(options.dependency).toLowerCase();
  const operation = options.operation;
  const deviceId = options.deviceId;
  const onTelemetry = options.onTelemetry;
  const onAdvisory = options.onAdvisory;

  if (!subjectId) {
    onTelemetry?.({
      event: "runtime.harness.degradation_registry",
      outcome: "rejected",
      subjectId: null,
      action: "invoke",
      failureClass: "missing_subject",
      silentWriteRetry: false,
      fabricated: false,
    });
    return {
      ok: false,
      degraded: true,
      behavior: "hard_stop",
      failureClass: "missing_subject",
      fabricated: false,
      silentWriteRetry: false,
      signalCode: "DEGRADE_HARD_STOP_WRITE",
      advisory: null,
      rolledBack: false,
      queued: false,
      subjectId: null,
      dependency: dependency || "unknown",
      operation,
      invokeCount: 0,
      detail: "subjectId required",
    };
  }

  if (!dependency) {
    return {
      ok: false,
      degraded: true,
      behavior: "hard_stop",
      failureClass: "invalid_dependency",
      fabricated: false,
      silentWriteRetry: false,
      signalCode: "DEGRADE_HARD_STOP_WRITE",
      advisory: null,
      rolledBack: false,
      queued: false,
      subjectId,
      dependency: "unknown",
      operation,
      invokeCount: 0,
      detail: "dependency name required",
    };
  }

  if (!(DEGRADATION_OPERATIONS as readonly string[]).includes(operation)) {
    return {
      ok: false,
      degraded: true,
      behavior: "hard_stop",
      failureClass: "schema_violation",
      fabricated: false,
      silentWriteRetry: false,
      signalCode: "DEGRADE_HARD_STOP_WRITE",
      advisory: null,
      rolledBack: false,
      queued: false,
      subjectId,
      dependency,
      operation,
      invokeCount: 0,
      detail: "operation must be read | write",
    };
  }

  let invokeCount: 0 | 1 = 0;
  try {
    invokeCount = 1;
    const value = await options.invoke();
    onTelemetry?.({
      event: "runtime.harness.degradation_registry",
      outcome: "ok",
      subjectId,
      ...(deviceId !== undefined ? { deviceId } : {}),
      action: "invoke",
      dependency,
      operation,
      silentWriteRetry: false,
      fabricated: false,
    });
    return {
      ok: true,
      degraded: false,
      value,
      subjectId,
      dependency,
      operation,
      invokeCount: 1,
    };
  } catch {
    // Typed degradation path — never unhandled rejection / silent retry.
  }

  // Exactly one attempt — do not re-enter invoke().
  const resolved = options.registry.resolve({
    dependency,
    operation,
    subjectId,
    ...(deviceId !== undefined ? { deviceId } : {}),
  });

  if (!resolved.ok) {
    onTelemetry?.({
      event: "runtime.harness.degradation_registry",
      outcome: "rejected",
      subjectId,
      ...(deviceId !== undefined ? { deviceId } : {}),
      action: "invoke",
      dependency,
      operation,
      failureClass: resolved.failureClass,
      silentWriteRetry: false,
      fabricated: false,
    });
    return {
      ok: false,
      degraded: true,
      behavior: "hard_stop",
      failureClass:
        resolved.failureClass === "missing_subject"
          ? "missing_subject"
          : "dependency_failure",
      fabricated: false,
      silentWriteRetry: false,
      signalCode: "DEGRADE_HARD_STOP_WRITE",
      advisory: null,
      rolledBack: false,
      queued: false,
      subjectId,
      dependency,
      operation,
      invokeCount,
      detail: resolved.detail,
    };
  }

  return applyResolvedDegradation<T>({
    resolved,
    subjectId,
    dependency,
    operation,
    invokeCount,
    ...(deviceId !== undefined ? { deviceId } : {}),
    ...(options.lastKnownGood !== undefined
      ? { lastKnownGood: options.lastKnownGood }
      : {}),
    ...(options.capturedAt !== undefined
      ? { capturedAt: options.capturedAt }
      : {}),
    ...(options.freshnessSource !== undefined
      ? { freshnessSource: options.freshnessSource }
      : {}),
    ...(options.rollback !== undefined ? { rollback: options.rollback } : {}),
    ...(options.enqueue !== undefined ? { enqueue: options.enqueue } : {}),
    ...(onTelemetry !== undefined ? { onTelemetry } : {}),
    ...(onAdvisory !== undefined ? { onAdvisory } : {}),
  });
}

/** Model adapter invoke site — consults registry on failure. */
export function invokeModelDependency<T>(
  options: Omit<InvokeWithDegradationOptions<T>, "dependency">,
): Promise<InvokeWithDegradationResult<T>> {
  return invokeWithDegradation({ ...options, dependency: "model" });
}

/** Sync transport invoke site — consults registry on failure. */
export function invokeSyncDependency<T>(
  options: Omit<InvokeWithDegradationOptions<T>, "dependency">,
): Promise<InvokeWithDegradationResult<T>> {
  return invokeWithDegradation({ ...options, dependency: "sync" });
}

/** Tool backend invoke site — consults registry on failure. */
export function invokeToolDependency<T>(
  options: Omit<InvokeWithDegradationOptions<T>, "dependency">,
): Promise<InvokeWithDegradationResult<T>> {
  return invokeWithDegradation({ ...options, dependency: "tool" });
}

async function applyResolvedDegradation<T>(input: {
  resolved: ResolveDegradationAccepted;
  subjectId: string;
  dependency: string;
  operation: DegradationOperation;
  deviceId?: string;
  invokeCount: 0 | 1;
  lastKnownGood?: T;
  capturedAt?: string;
  freshnessSource?: FreshnessMarker["source"];
  rollback?: () => void | Promise<void>;
  enqueue?: InvokeWithDegradationOptions<T>["enqueue"];
  onTelemetry?: (event: DegradationRegistryTelemetryEvent) => void;
  onAdvisory?: (signal: DegradationAdvisorySignal) => void;
}): Promise<InvokeWithDegradationResult<T>> {
  const { resolved, subjectId, dependency, operation, invokeCount } = input;
  const deviceId = input.deviceId;
  const { behavior, mode, signalCode, spec } = resolved;

  const scoped = {
    subjectId,
    dependency,
    operation,
    invokeCount,
    ...(deviceId !== undefined ? { deviceId } : {}),
    ...(input.rollback !== undefined ? { rollback: input.rollback } : {}),
    ...(input.enqueue !== undefined ? { enqueue: input.enqueue } : {}),
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
    ...(input.onAdvisory !== undefined
      ? { onAdvisory: input.onAdvisory }
      : {}),
  };

  // Writes never stale-serve or silent-retry — hard-stop or queue only.
  if (operation === "write") {
    if (behavior === "queue") {
      return finishQueued({
        ...scoped,
        behavior: "queue",
        mode: "QUEUE_AND_WARN",
        signalCode:
          mode === "QUEUE_AND_WARN" ? signalCode : "DEGRADE_QUEUE_AND_WARN",
      });
    }

    return finishHardStop({
      ...scoped,
      behavior: "hard_stop",
      mode: "HARD_STOP_WRITE",
      signalCode:
        mode === "HARD_STOP_WRITE" ? signalCode : "DEGRADE_HARD_STOP_WRITE",
      failureClass: "write_hard_stopped",
      detail: "write hard-stopped — no silent retry",
    });
  }

  // Reads: stale_with_marker → LKG + freshness marker (never fabricate).
  if (
    behavior === "stale_with_marker" ||
    spec.readPolicy === "stale-with-marker"
  ) {
    const capturedAt =
      typeof input.capturedAt === "string" ? input.capturedAt.trim() : "";
    if (input.lastKnownGood === undefined || !capturedAt) {
      return finishHardStop({
        ...scoped,
        behavior: "hard_stop",
        mode: "HARD_STOP_WRITE",
        signalCode: "DEGRADE_HARD_STOP_WRITE",
        failureClass: "missing_last_known_good",
        detail:
          "stale_with_marker requires lastKnownGood + capturedAt — never fabricate",
        advisoryOutcome: "blocked_no_lkg",
      });
    }

    const lastKnownGood = input.lastKnownGood;
    const freshnessMarker: FreshnessMarker = {
      capturedAt,
      source: input.freshnessSource ?? "last-known-good",
    };
    const payload = {
      value: lastKnownGood,
      freshnessMarker,
      fabricated: false as const,
    };
    const asserted = assertStaleReadPayload(payload, { subjectId });
    if (!asserted.ok) {
      return finishHardStop({
        ...scoped,
        behavior: "hard_stop",
        mode: "HARD_STOP_WRITE",
        signalCode: "DEGRADE_HARD_STOP_WRITE",
        failureClass: "missing_last_known_good",
        detail: `stale payload rejected: ${asserted.failureClass}`,
        advisoryOutcome: "blocked_no_lkg",
      });
    }

    const advisory = emitAdvisory({
      subjectId,
      ...(deviceId !== undefined ? { deviceId } : {}),
      dependency,
      operation,
      behavior: "stale_with_marker",
      mode: "STALE_READ",
      signalCode: mode === "STALE_READ" ? signalCode : "DEGRADE_STALE_READ",
      outcome: "stale_served",
      ...(input.onTelemetry !== undefined
        ? { onTelemetry: input.onTelemetry }
        : {}),
      ...(input.onAdvisory !== undefined
        ? { onAdvisory: input.onAdvisory }
        : {}),
    });

    return {
      ok: true,
      degraded: true,
      behavior: "stale_with_marker",
      value: lastKnownGood,
      freshnessMarker,
      fabricated: false,
      silentWriteRetry: false,
      signalCode: advisory.signalCode,
      advisory,
      subjectId,
      dependency,
      operation,
      invokeCount: 1,
      payload,
    };
  }

  if (behavior === "queue") {
    return finishQueued({
      ...scoped,
      behavior: "queue",
      mode: "QUEUE_AND_WARN",
      signalCode:
        mode === "QUEUE_AND_WARN" ? signalCode : "DEGRADE_QUEUE_AND_WARN",
    });
  }

  return finishHardStop({
    ...scoped,
    behavior: "hard_stop",
    mode: "HARD_STOP_WRITE",
    signalCode:
      mode === "HARD_STOP_WRITE" ? signalCode : "DEGRADE_HARD_STOP_WRITE",
    failureClass: "dependency_failure",
    detail: "dependency unavailable — hard_stop",
  });
}

async function finishHardStop(input: {
  subjectId: string;
  dependency: string;
  operation: DegradationOperation;
  behavior: DegradationBehavior;
  mode: DegradationMode;
  signalCode: string;
  failureClass:
    | "dependency_failure"
    | "missing_last_known_good"
    | "write_hard_stopped";
  detail: string;
  invokeCount: 0 | 1;
  deviceId?: string;
  rollback?: () => void | Promise<void>;
  advisoryOutcome?: DegradationAdvisoryOutcome;
  onTelemetry?: (event: DegradationRegistryTelemetryEvent) => void;
  onAdvisory?: (signal: DegradationAdvisorySignal) => void;
}): Promise<InvokeWithDegradationResult<never>> {
  let rolledBack = false;
  if (input.rollback) {
    await input.rollback();
    rolledBack = true;
  }

  const advisory = emitAdvisory({
    subjectId: input.subjectId,
    ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
    dependency: input.dependency,
    operation: input.operation,
    behavior: input.behavior,
    mode: input.mode,
    signalCode: input.signalCode,
    outcome: input.advisoryOutcome ?? "hard_stopped",
    rolledBack,
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
    ...(input.onAdvisory !== undefined
      ? { onAdvisory: input.onAdvisory }
      : {}),
  });

  return {
    ok: false,
    degraded: true,
    behavior: input.behavior,
    failureClass: input.failureClass,
    fabricated: false,
    silentWriteRetry: false,
    signalCode: input.signalCode,
    advisory,
    rolledBack,
    queued: false,
    subjectId: input.subjectId,
    dependency: input.dependency,
    operation: input.operation,
    invokeCount: input.invokeCount,
    detail: input.detail,
  };
}

async function finishQueued(input: {
  subjectId: string;
  dependency: string;
  operation: DegradationOperation;
  behavior: "queue";
  mode: DegradationMode;
  signalCode: string;
  invokeCount: 0 | 1;
  deviceId?: string;
  enqueue?: InvokeWithDegradationOptions<unknown>["enqueue"];
  onTelemetry?: (event: DegradationRegistryTelemetryEvent) => void;
  onAdvisory?: (signal: DegradationAdvisorySignal) => void;
}): Promise<InvokeWithDegradationResult<never>> {
  let queued = false;
  if (input.enqueue) {
    await input.enqueue({
      dependency: input.dependency,
      operation: input.operation,
      subjectId: input.subjectId,
      signalCode: input.signalCode,
    });
    queued = true;
  }

  const advisory = emitAdvisory({
    subjectId: input.subjectId,
    ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
    dependency: input.dependency,
    operation: input.operation,
    behavior: "queue",
    mode: input.mode,
    signalCode: input.signalCode,
    outcome: "queued",
    queued,
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
    ...(input.onAdvisory !== undefined
      ? { onAdvisory: input.onAdvisory }
      : {}),
  });

  return {
    ok: false,
    degraded: true,
    behavior: "queue",
    failureClass: "queued",
    fabricated: false,
    silentWriteRetry: false,
    signalCode: input.signalCode,
    advisory,
    rolledBack: false,
    queued,
    subjectId: input.subjectId,
    dependency: input.dependency,
    operation: input.operation,
    invokeCount: input.invokeCount,
    detail: "dependency down — queued with advisory (not silent continue)",
  };
}

function emitAdvisory(input: {
  subjectId: string;
  deviceId?: string;
  dependency: string;
  operation: DegradationOperation;
  behavior: DegradationBehavior;
  mode: DegradationMode;
  signalCode: string;
  outcome: DegradationAdvisoryOutcome;
  rolledBack?: boolean;
  queued?: boolean;
  onTelemetry?: (event: DegradationRegistryTelemetryEvent) => void;
  onAdvisory?: (signal: DegradationAdvisorySignal) => void;
}): DegradationAdvisorySignal {
  const signal: DegradationAdvisorySignal = {
    event: "runtime.harness.degradation_advisory",
    subjectId: input.subjectId,
    ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
    dependency: input.dependency,
    operation: input.operation,
    behavior: input.behavior,
    mode: input.mode,
    signalCode: input.signalCode,
    outcome: input.outcome,
    silentWriteRetry: false,
    fabricated: false,
    ...(input.rolledBack !== undefined ? { rolledBack: input.rolledBack } : {}),
    ...(input.queued !== undefined ? { queued: input.queued } : {}),
  };

  input.onAdvisory?.(signal);
  input.onTelemetry?.({
    event: "runtime.harness.degradation_registry",
    outcome: "advisory",
    subjectId: input.subjectId,
    ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
    action: "invoke",
    dependency: input.dependency,
    operation: input.operation,
    behavior: input.behavior,
    mode: input.mode,
    signalCode: input.signalCode,
    advisoryOutcome: input.outcome,
    silentWriteRetry: false,
    fabricated: false,
    ...(input.rolledBack !== undefined ? { rolledBack: input.rolledBack } : {}),
    ...(input.queued !== undefined ? { queued: input.queued } : {}),
  });

  return signal;
}

function trimStr(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/* ────────────────────────────────────────────────────────────────────────
 * Per-behavior regression fixtures (stub failure → exact behavior/signal)
 * ──────────────────────────────────────────────────────────────────────── */

/** Soft cap on per-behavior regression cases (NFR — bounded corpus). */
export const DEGRADATION_BEHAVIOR_CASE_LIMIT = 32;

/** Relative path under `@moolam/runtime-harness` for behavior unit fixtures. */
export const DEGRADATION_BEHAVIOR_FIXTURE_RELPATH =
  "fixtures/degradation-behavior" as const;

/** Expected signal code per host Behavior (maps A P6 modes). */
export const DEGRADATION_BEHAVIOR_SIGNAL_CODES = Object.freeze({
  stale_with_marker: "DEGRADE_STALE_READ",
  queue: "DEGRADE_QUEUE_AND_WARN",
  hard_stop: "DEGRADE_HARD_STOP_WRITE",
} as const satisfies Record<DegradationBehavior, string>);

export type DegradationBehaviorCase = {
  id: string;
  /** Product/spec row this case protects — never a stage task id. */
  specId: string;
  /** Human-readable invariant comment for the failure-mode scenario. */
  protects: string;
  subjectId: string;
  deviceId?: string;
  dependency: string;
  operation: DegradationOperation;
  forcedFailure: {
    kind: "dependency_unavailable" | "timeout" | "corrupt_response" | "partial_failure";
    dependency: string;
  };
  expectedBehavior: DegradationBehavior;
  expectedSignalCode: string;
  /** When true, expect ok+degraded stale serve; when false, expect blocked. */
  expectedOk: boolean;
  expectedDegraded: boolean;
  requiresLastKnownGood?: boolean;
  requiresRollback?: boolean;
  requiresEnqueue?: boolean;
  /** Optional host register() overlay before invoke (e.g. tool → hard_stop). */
  register?: { dependency: string; behavior: DegradationBehavior };
  allowsFabrication: false;
  allowsSilentWriteRetry: false;
  idempotencyKey: string;
};

export type RunDegradationBehaviorCaseAccepted = {
  ok: true;
  caseId: string;
  subjectId: string;
  deviceId?: string;
  dependency: string;
  operation: DegradationOperation;
  behavior: DegradationBehavior;
  signalCode: string;
  fabricated: false;
  silentWriteRetry: false;
  invokeCount: 0 | 1;
  rolledBack: boolean;
  queued: boolean;
  /** First observation of idempotencyKey in the provided seen set. */
  idempotentFirst: boolean;
  advisoryOutcome: DegradationAdvisoryOutcome | "ok_undegraded" | null;
};

export type RunDegradationBehaviorCaseRejected = {
  ok: false;
  caseId: string;
  subjectId: string | null;
  failureClass:
    | "schema_violation"
    | "behavior_mismatch"
    | "signal_mismatch"
    | "fabrication_forbidden"
    | "silent_retry_forbidden"
    | "missing_subject"
    | "outcome_mismatch"
    | "section_limit";
  detail: string;
};

export type RunDegradationBehaviorCaseResult =
  | RunDegradationBehaviorCaseAccepted
  | RunDegradationBehaviorCaseRejected;

/**
 * Parse one per-behavior fixture case (metadata only — no learner content).
 */
export function parseDegradationBehaviorCase(
  input: unknown,
):
  | { ok: true; case: DegradationBehaviorCase }
  | { ok: false; failureClass: "schema_violation"; detail: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      failureClass: "schema_violation",
      detail: "case must be an object",
    };
  }
  const r = input as Record<string, unknown>;
  const id = trimStr(r.id);
  const specId = trimStr(r.specId);
  const protects = trimStr(r.protects);
  const subjectId = trimStr(r.subjectId);
  const dependency = trimStr(r.dependency).toLowerCase();
  const operation = r.operation;
  const expectedBehavior = r.expectedBehavior;
  const expectedSignalCode = trimStr(r.expectedSignalCode);
  const idempotencyKey = trimStr(r.idempotencyKey);
  const forced = r.forcedFailure;

  if (!id || !specId || !protects || !subjectId || !dependency) {
    return {
      ok: false,
      failureClass: "schema_violation",
      detail: "id, specId, protects, subjectId, dependency required",
    };
  }
  if (!(DEGRADATION_OPERATIONS as readonly string[]).includes(operation as string)) {
    return {
      ok: false,
      failureClass: "schema_violation",
      detail: "operation must be read | write",
    };
  }
  if (!isDegradationBehavior(expectedBehavior)) {
    return {
      ok: false,
      failureClass: "schema_violation",
      detail: "expectedBehavior must be stale_with_marker | queue | hard_stop",
    };
  }
  if (!expectedSignalCode || !idempotencyKey) {
    return {
      ok: false,
      failureClass: "schema_violation",
      detail: "expectedSignalCode and idempotencyKey required",
    };
  }
  if (r.allowsFabrication !== false || r.allowsSilentWriteRetry !== false) {
    return {
      ok: false,
      failureClass: "schema_violation",
      detail: "allowsFabrication and allowsSilentWriteRetry must be false",
    };
  }
  if (!forced || typeof forced !== "object" || Array.isArray(forced)) {
    return {
      ok: false,
      failureClass: "schema_violation",
      detail: "forcedFailure required",
    };
  }
  const ff = forced as Record<string, unknown>;
  const kind = ff.kind;
  const ffDep = trimStr(ff.dependency);
  if (
    kind !== "dependency_unavailable" &&
    kind !== "timeout" &&
    kind !== "corrupt_response" &&
    kind !== "partial_failure"
  ) {
    return {
      ok: false,
      failureClass: "schema_violation",
      detail: "forcedFailure.kind invalid",
    };
  }
  if (!ffDep) {
    return {
      ok: false,
      failureClass: "schema_violation",
      detail: "forcedFailure.dependency required",
    };
  }
  if (typeof r.expectedOk !== "boolean" || typeof r.expectedDegraded !== "boolean") {
    return {
      ok: false,
      failureClass: "schema_violation",
      detail: "expectedOk and expectedDegraded must be boolean",
    };
  }

  let register: DegradationBehaviorCase["register"];
  if (r.register !== undefined) {
    if (!r.register || typeof r.register !== "object" || Array.isArray(r.register)) {
      return {
        ok: false,
        failureClass: "schema_violation",
        detail: "register must be an object when present",
      };
    }
    const reg = r.register as Record<string, unknown>;
    const regDep = trimStr(reg.dependency).toLowerCase();
    if (!regDep || !isDegradationBehavior(reg.behavior)) {
      return {
        ok: false,
        failureClass: "schema_violation",
        detail: "register.dependency and register.behavior required",
      };
    }
    register = { dependency: regDep, behavior: reg.behavior };
  }

  const parsed: DegradationBehaviorCase = {
    id,
    specId,
    protects,
    subjectId,
    dependency,
    operation: operation as DegradationOperation,
    forcedFailure: { kind, dependency: ffDep },
    expectedBehavior,
    expectedSignalCode,
    expectedOk: r.expectedOk,
    expectedDegraded: r.expectedDegraded,
    allowsFabrication: false,
    allowsSilentWriteRetry: false,
    idempotencyKey,
    ...(typeof r.deviceId === "string" && r.deviceId.trim()
      ? { deviceId: r.deviceId.trim() }
      : {}),
    ...(r.requiresLastKnownGood === true
      ? { requiresLastKnownGood: true }
      : {}),
    ...(r.requiresRollback === true ? { requiresRollback: true } : {}),
    ...(r.requiresEnqueue === true ? { requiresEnqueue: true } : {}),
    ...(register !== undefined ? { register } : {}),
  };
  return { ok: true, case: parsed };
}

/**
 * Stub a dependency failure for one fixture case; assert exact Behavior +
 * signal code. Never fabricates; never silent-retries writes.
 */
export async function runDegradationBehaviorCase(
  input: unknown,
  options: {
    onTelemetry?: (event: DegradationRegistryTelemetryEvent) => void;
    onAdvisory?: (signal: DegradationAdvisorySignal) => void;
    /** Shared set for replayed-key idempotency across concurrent/repeated runs. */
    seenIdempotencyKeys?: Set<string>;
  } = {},
): Promise<RunDegradationBehaviorCaseResult> {
  const parsed = parseDegradationBehaviorCase(input);
  if (!parsed.ok) {
    return {
      ok: false,
      caseId:
        input &&
        typeof input === "object" &&
        typeof (input as { id?: unknown }).id === "string"
          ? (input as { id: string }).id
          : "(unknown)",
      subjectId: null,
      failureClass: "schema_violation",
      detail: parsed.detail,
    };
  }

  const fixtureCase = parsed.case;
  if (!fixtureCase.subjectId) {
    return {
      ok: false,
      caseId: fixtureCase.id,
      subjectId: null,
      failureClass: "missing_subject",
      detail: "subjectId required",
    };
  }

  const loaded = loadDegradationRegistry({
    subjectId: fixtureCase.subjectId,
    ...(fixtureCase.deviceId !== undefined
      ? { deviceId: fixtureCase.deviceId }
      : {}),
    ...(options.onTelemetry !== undefined
      ? { onTelemetry: options.onTelemetry }
      : {}),
  });
  if (!loaded.ok) {
    return {
      ok: false,
      caseId: fixtureCase.id,
      subjectId: fixtureCase.subjectId,
      failureClass: "schema_violation",
      detail: loaded.detail,
    };
  }

  if (fixtureCase.register) {
    const reg = loaded.registry.register(
      fixtureCase.register.dependency,
      fixtureCase.register.behavior,
      { subjectId: fixtureCase.subjectId },
    );
    if (!reg.ok && reg.failureClass !== "conflict") {
      return {
        ok: false,
        caseId: fixtureCase.id,
        subjectId: fixtureCase.subjectId,
        failureClass: "schema_violation",
        detail: reg.detail,
      };
    }
  }

  const seen = options.seenIdempotencyKeys ?? new Set<string>();
  const first = !seen.has(fixtureCase.idempotencyKey);
  if (first) {
    seen.add(fixtureCase.idempotencyKey);
  }

  let rollbackCalls = 0;
  let enqueueCalls = 0;
  /** Host-durable counter — only increments on first idempotency claim. */
  let durableApplied = 0;

  const invokeResult = await invokeWithDegradation({
    registry: loaded.registry,
    dependency: fixtureCase.dependency,
    operation: fixtureCase.operation,
    subjectId: fixtureCase.subjectId,
    ...(fixtureCase.deviceId !== undefined
      ? { deviceId: fixtureCase.deviceId }
      : {}),
    ...(fixtureCase.requiresLastKnownGood
      ? {
          lastKnownGood: {
            snapshot: "last-known-good",
            subjectId: fixtureCase.subjectId,
          },
          capturedAt: "2026-07-15T12:00:00.000Z",
          freshnessSource: "last-known-good" as const,
        }
      : {}),
    invoke: async () => {
      // Partial failure: durable attempt before forced outage.
      // Replayed keys must not double-apply host durable effects.
      if (first) {
        durableApplied += 1;
      }
      const err = new Error(
        `${fixtureCase.forcedFailure.kind}:${fixtureCase.forcedFailure.dependency}`,
      );
      (err as { name: string }).name = "DependencyForcedFailure";
      throw err;
    },
    rollback: async () => {
      rollbackCalls += 1;
      if (first && durableApplied > 0) {
        durableApplied -= 1;
      }
    },
    enqueue: async () => {
      enqueueCalls += 1;
    },
    ...(options.onTelemetry !== undefined
      ? { onTelemetry: options.onTelemetry }
      : {}),
    ...(options.onAdvisory !== undefined
      ? { onAdvisory: options.onAdvisory }
      : {}),
  });

  void durableApplied;

  if (fixtureCase.allowsFabrication !== false) {
    return {
      ok: false,
      caseId: fixtureCase.id,
      subjectId: fixtureCase.subjectId,
      failureClass: "fabrication_forbidden",
      detail: "fixture must forbid fabrication",
    };
  }
  if (fixtureCase.allowsSilentWriteRetry !== false) {
    return {
      ok: false,
      caseId: fixtureCase.id,
      subjectId: fixtureCase.subjectId,
      failureClass: "silent_retry_forbidden",
      detail: "fixture must forbid silent write retry",
    };
  }

  if (invokeResult.ok !== fixtureCase.expectedOk) {
    return {
      ok: false,
      caseId: fixtureCase.id,
      subjectId: fixtureCase.subjectId,
      failureClass: "outcome_mismatch",
      detail: `expectedOk=${fixtureCase.expectedOk} got ok=${invokeResult.ok}`,
    };
  }
  if (invokeResult.degraded !== fixtureCase.expectedDegraded) {
    return {
      ok: false,
      caseId: fixtureCase.id,
      subjectId: fixtureCase.subjectId,
      failureClass: "outcome_mismatch",
      detail: `expectedDegraded=${fixtureCase.expectedDegraded} got ${invokeResult.degraded}`,
    };
  }

  const behavior =
    invokeResult.degraded === true
      ? invokeResult.behavior
      : fixtureCase.expectedBehavior;
  if (invokeResult.degraded && behavior !== fixtureCase.expectedBehavior) {
    return {
      ok: false,
      caseId: fixtureCase.id,
      subjectId: fixtureCase.subjectId,
      failureClass: "behavior_mismatch",
      detail: `expected ${fixtureCase.expectedBehavior} got ${behavior}`,
    };
  }

  const signalCode =
    invokeResult.degraded === true
      ? invokeResult.signalCode
      : fixtureCase.expectedSignalCode;
  if (
    invokeResult.degraded &&
    signalCode !== fixtureCase.expectedSignalCode
  ) {
    return {
      ok: false,
      caseId: fixtureCase.id,
      subjectId: fixtureCase.subjectId,
      failureClass: "signal_mismatch",
      detail: `expected ${fixtureCase.expectedSignalCode} got ${signalCode}`,
    };
  }

  if (invokeResult.degraded) {
    if (invokeResult.fabricated !== false) {
      return {
        ok: false,
        caseId: fixtureCase.id,
        subjectId: fixtureCase.subjectId,
        failureClass: "fabrication_forbidden",
        detail: "degraded result must set fabricated=false",
      };
    }
    if (invokeResult.silentWriteRetry !== false) {
      return {
        ok: false,
        caseId: fixtureCase.id,
        subjectId: fixtureCase.subjectId,
        failureClass: "silent_retry_forbidden",
        detail: "degraded result must set silentWriteRetry=false",
      };
    }
  }

  if (
    fixtureCase.requiresRollback === true &&
    (!("rolledBack" in invokeResult) || invokeResult.rolledBack !== true)
  ) {
    return {
      ok: false,
      caseId: fixtureCase.id,
      subjectId: fixtureCase.subjectId,
      failureClass: "outcome_mismatch",
      detail: `requiresRollback but rolledBack=${"rolledBack" in invokeResult ? invokeResult.rolledBack : false} rollbackCalls=${rollbackCalls}`,
    };
  }

  if (
    fixtureCase.requiresEnqueue === true &&
    (!("queued" in invokeResult) || invokeResult.queued !== true || enqueueCalls < 1)
  ) {
    return {
      ok: false,
      caseId: fixtureCase.id,
      subjectId: fixtureCase.subjectId,
      failureClass: "outcome_mismatch",
      detail: `requiresEnqueue but queued=${"queued" in invokeResult ? invokeResult.queued : false}`,
    };
  }

  if (
    fixtureCase.expectedOk &&
    fixtureCase.expectedBehavior === "stale_with_marker" &&
    invokeResult.ok &&
    invokeResult.degraded
  ) {
    const asserted = assertStaleReadPayload(invokeResult.payload, {
      subjectId: fixtureCase.subjectId,
    });
    if (!asserted.ok) {
      return {
        ok: false,
        caseId: fixtureCase.id,
        subjectId: fixtureCase.subjectId,
        failureClass: "fabrication_forbidden",
        detail: `stale payload rejected: ${asserted.failureClass}`,
      };
    }
  }

  const advisoryOutcome =
    invokeResult.degraded && invokeResult.advisory
      ? invokeResult.advisory.outcome
      : invokeResult.degraded
        ? null
        : ("ok_undegraded" as const);

  return {
    ok: true,
    caseId: fixtureCase.id,
    subjectId: fixtureCase.subjectId,
    ...(fixtureCase.deviceId !== undefined
      ? { deviceId: fixtureCase.deviceId }
      : {}),
    dependency: fixtureCase.dependency,
    operation: fixtureCase.operation,
    behavior: fixtureCase.expectedBehavior,
    signalCode: fixtureCase.expectedSignalCode,
    fabricated: false,
    silentWriteRetry: false,
    invokeCount: invokeResult.invokeCount,
    rolledBack:
      "rolledBack" in invokeResult ? invokeResult.rolledBack === true : false,
    queued: "queued" in invokeResult ? invokeResult.queued === true : false,
    idempotentFirst: first,
    advisoryOutcome,
  };
}

/**
 * Assert a behavior corpus covers every host Behavior exactly once at minimum.
 */
export function assertBehaviorCorpusCoverage(
  cases: readonly DegradationBehaviorCase[],
): { ok: true } | { ok: false; detail: string } {
  if (cases.length === 0 || cases.length > DEGRADATION_BEHAVIOR_CASE_LIMIT) {
    return {
      ok: false,
      detail: `case count must be 1..${DEGRADATION_BEHAVIOR_CASE_LIMIT}`,
    };
  }
  const seenIds = new Set<string>();
  const covered = new Set<DegradationBehavior>();
  for (const c of cases) {
    if (seenIds.has(c.id)) {
      return { ok: false, detail: `duplicate case id ${c.id}` };
    }
    seenIds.add(c.id);
    covered.add(c.expectedBehavior);
  }
  for (const behavior of DEGRADATION_BEHAVIORS) {
    if (!covered.has(behavior)) {
      return { ok: false, detail: `missing case for behavior ${behavior}` };
    }
  }
  return { ok: true };
}

export {
  DEGRADATION_MODES,
  DEGRADATION_OPERATIONS,
  DEGRADATION_SURFACES,
  DEFAULT_DEGRADATION_REGISTRY,
  type DegradationMode,
  type DegradationOperation,
  type DegradationSurface,
  type DegradationBehaviorSpec,
  type DegradationRegistryDocument,
};
