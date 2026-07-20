/**
 * Locality boundary harness .
 *
 * 001 — undici global-dispatcher egress recorder (destination class, CallerContext
 *       initiator binding, payload-class markers; documented interception scope).
 * 002 — data-class → allowed-locality policy, {@link assertLocality}, and
 *       registrable CK-03 locality obligations.
 *
 * @module locality/harness
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  MockAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
  type Dispatcher,
} from "undici";
import {
  ObligationRegistry,
  ObligationViolation,
  defineObligation,
  type Obligation,
  type ObligationContext,
} from "../registry.js";
import type { FactoryContext, ImplementationFactory } from "../runner.js";

/* ────────────────────────────────────────────────────────────────────────
 * Interception scope (documented seam — epic risk: false confidence)
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Widest seam this harness owns. Red-team and binding certs must treat anything
 * outside this set as **unproven** by the recorder.
 */
export const EGRESS_INTERCEPTION_SCOPE = {
  /** Captured when traffic uses Node's global `fetch` or undici with the global dispatcher. */
  inScope: [
    "global fetch (Node undici)",
    "undici Agent / Pool / Client that use setGlobalDispatcher",
    "undici request/stream/pipeline routed through the installed global dispatcher",
  ],
  /** Not intercepted — do not claim locality proofs over these paths. */
  outOfScope: [
    "node:net / node:tls raw sockets",
    "node:http / node:https request that bypasses undici",
    "child_process curl/wget and other OS helpers",
    "WebSocket / gRPC / native addon stacks with their own I/O",
    "browser XHR / non-Node runtimes",
  ],
} as const;

export type EgressInterceptionScope = typeof EGRESS_INTERCEPTION_SCOPE;

/* ────────────────────────────────────────────────────────────────────────
 * Destination + payload markers
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Classification of an **actual egress** attempt.
 * `on-device` is not a destination class: an on-device turn is proven by
 * **zero** recorded egress attempts.
 */
export type EgressDestinationClass = "self-hosted" | "third-party";

/**
 * Payload class markers — metadata grade only. Never store raw learner text.
 * Tests set markers around prompt/sync calls so red-team assertions (002+)
 * can bind data class → locality.
 */
export type PayloadClassMarker =
  | "none"
  | "metadata"
  | "cognitive-state"
  | "regulated"
  | "model-prompt"
  | "unknown";

/** Track A CallerContext shape (principal + subject scope) for initiator binding. */
export type LocalityCallerBinding = {
  principalId: string;
  subjectScope: "*" | readonly string[];
};

export type EgressInitiatorBinding = {
  subjectId: string;
  deviceId: string;
  turnId: string;
  principalId: string;
};

export type EgressAttemptRecord = {
  /** Hostname only (no path/query — those may carry secrets). */
  destinationHost: string;
  /** Scheme + host + port; never includes path or search. */
  destinationOrigin: string;
  destinationClass: EgressDestinationClass;
  method: string;
  initiator: EgressInitiatorBinding;
  payloadClass: PayloadClassMarker;
  recordedAtMs: number;
};

export type LocalityEgressEvent = {
  event: "locality.egress";
  subjectId: string;
  deviceId: string;
  turnId: string;
  outcome:
    | "turn_start"
    | "turn_end"
    | "recorded"
    | "dropped_cap"
    | "deadline"
    | "caller_denied"
    | "setup_error"
    | "teardown_error";
  destinationClass?: EgressDestinationClass;
  destinationHost?: string;
  payloadClass?: PayloadClassMarker;
  principalId?: string;
};

export const DEFAULT_EGRESS_TURN_DEADLINE_MS = 5_000;
export const DEFAULT_MAX_EGRESS_RECORDS = 256;

/** Raised when an instrumented turn exceeds its wall-clock deadline. */
export class EgressTurnDeadlineError extends Error {
  readonly turnId: string;
  readonly deadlineMs: number;

  constructor(turnId: string, deadlineMs: number) {
    super(`egress-recording turn '${turnId}' exceeded deadline of ${deadlineMs}ms`);
    this.name = "EgressTurnDeadlineError";
    this.turnId = turnId;
    this.deadlineMs = deadlineMs;
  }
}

/** Raised when CallerContext subject scope does not include the turn subject. */
export class EgressCallerDeniedError extends Error {
  readonly subjectId: string;
  readonly principalId: string;

  constructor(principalId: string, subjectId: string) {
    super(
      `caller '${principalId}' subjectScope does not include subjectId '${subjectId}'`,
    );
    this.name = "EgressCallerDeniedError";
    this.principalId = principalId;
    this.subjectId = subjectId;
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * Allowlist + recording helpers
 * ──────────────────────────────────────────────────────────────────────── */

export function normalizeEgressHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

export function classifyEgressDestination(
  host: string,
  selfHostedHosts: ReadonlySet<string>,
): EgressDestinationClass {
  const normalized = normalizeEgressHost(host);
  if (selfHostedHosts.has(normalized)) return "self-hosted";
  return "third-party";
}

const LOOPBACK_HOST_ALIASES = new Set([
  "127.0.0.1",
  "localhost",
  "::1",
  "[::1]",
]);

export type LoopbackPermitEgressMockAgentOptions = {
  /**
   * TCP ports to allow for loopback hosts. Undici on Windows requires
   * `host:port` (not bare IP) for `enableNetConnect`.
   */
  ports?: readonly number[];
};

/**
 * Undici MockAgent for live local inference: records egress but permits real
 * HTTP to loopback / self-hosted hosts (e.g. Ollama on 127.0.0.1:11434).
 */
export function createLoopbackPermitEgressMockAgent(
  permittedHosts: readonly string[],
  options?: LoopbackPermitEgressMockAgentOptions,
): MockAgent {
  const mock = new MockAgent();
  mock.disableNetConnect();
  const seen = new Set<string>();
  const ports = options?.ports?.length ? [...options.ports] : [11434];

  const permit = (endpoint: string): void => {
    const normalized = endpoint.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    mock.enableNetConnect(normalized);
  };

  for (const host of permittedHosts) {
    const normalized = normalizeEgressHost(host);
    if (!normalized) continue;

    if (/:\d+$/.test(normalized) || normalized.startsWith("[")) {
      permit(normalized);
      continue;
    }

    permit(normalized);

    if (LOOPBACK_HOST_ALIASES.has(normalized)) {
      for (const port of ports) {
        permit(`127.0.0.1:${port}`);
        permit(`localhost:${port}`);
        if (normalized === "::1" || normalized === "[::1]") {
          permit(`[::1]:${port}`);
        }
      }
    }
  }

  return mock;
}

export function callerAllowsSubject(
  caller: LocalityCallerBinding,
  subjectId: string,
): boolean {
  if (caller.subjectScope === "*") return true;
  return caller.subjectScope.includes(subjectId);
}

function originParts(origin: string | URL): { host: string; origin: string } {
  const url = typeof origin === "string" ? new URL(origin) : new URL(origin.href);
  return {
    host: normalizeEgressHost(url.hostname),
    origin: url.origin,
  };
}

function raceDeadline<T>(
  work: Promise<T>,
  deadlineMs: number,
  onTimeout: () => Error,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(onTimeout());
    }, deadlineMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/* ────────────────────────────────────────────────────────────────────────
 * AsyncLocalStorage turn state + process-global recorder install
 * ──────────────────────────────────────────────────────────────────────── */

type TurnAlsState = {
  turnId: string;
  subjectId: string;
  deviceId: string;
  principalId: string;
  selfHostedHosts: ReadonlySet<string>;
  records: EgressAttemptRecord[];
  maxRecords: number;
  payloadClass: PayloadClassMarker;
  emit: ((event: LocalityEgressEvent) => void) | undefined;
  dropped: boolean;
};

const turnAls = new AsyncLocalStorage<TurnAlsState>();

type GlobalRecorderState = {
  installCount: number;
  previous: Dispatcher;
  mock: MockAgent | null;
  composed: Dispatcher;
};

let globalRecorder: GlobalRecorderState | null = null;

/** Serialize install/teardown of the process-global undici dispatcher. */
let dispatcherSetupChain: Promise<void> = Promise.resolve();

function withDispatcherSetupMutex<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = dispatcherSetupChain.then(fn, fn);
  dispatcherSetupChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function recordFromDispatchOptions(
  state: TurnAlsState,
  options: { origin?: string | URL; path?: string; method?: string },
): void {
  if (options.origin === undefined) return;
  const { host, origin } = originParts(options.origin);
  const destinationClass = classifyEgressDestination(host, state.selfHostedHosts);
  const payloadClass = state.payloadClass;

  if (state.records.length >= state.maxRecords) {
    if (!state.dropped) {
      state.dropped = true;
      state.emit?.({
        event: "locality.egress",
        subjectId: state.subjectId,
        deviceId: state.deviceId,
        turnId: state.turnId,
        outcome: "dropped_cap",
        destinationClass,
        destinationHost: host,
        payloadClass,
        principalId: state.principalId,
      });
    }
    return;
  }

  const record: EgressAttemptRecord = {
    destinationHost: host,
    destinationOrigin: origin,
    destinationClass,
    method: (options.method ?? "GET").toUpperCase(),
    initiator: {
      subjectId: state.subjectId,
      deviceId: state.deviceId,
      turnId: state.turnId,
      principalId: state.principalId,
    },
    payloadClass,
    recordedAtMs: Date.now(),
  };
  state.records.push(record);
  state.emit?.({
    event: "locality.egress",
    subjectId: state.subjectId,
    deviceId: state.deviceId,
    turnId: state.turnId,
    outcome: "recorded",
    destinationClass,
    destinationHost: host,
    payloadClass,
    principalId: state.principalId,
  });
}

function installGlobalRecorder(downstream: Dispatcher): GlobalRecorderState {
  if (globalRecorder) {
    globalRecorder.installCount += 1;
    return globalRecorder;
  }
  const previous = getGlobalDispatcher();
  const composed = downstream.compose((dispatch) => {
    return (opts, handler) => {
      const state = turnAls.getStore();
      if (state) {
        recordFromDispatchOptions(state, opts);
      }
      return dispatch(opts, handler);
    };
  });
  setGlobalDispatcher(composed);
  globalRecorder = {
    installCount: 1,
    previous,
    mock: downstream instanceof MockAgent ? downstream : null,
    composed,
  };
  return globalRecorder;
}

async function releaseGlobalRecorder(): Promise<void> {
  if (!globalRecorder) return;
  globalRecorder.installCount -= 1;
  if (globalRecorder.installCount > 0) return;
  const { previous, mock } = globalRecorder;
  globalRecorder = null;
  try {
    setGlobalDispatcher(previous);
  } catch {
    // Best-effort restore; tests still see teardown_error via emit if we choose.
  }
  if (mock) {
    await mock.close().catch(() => undefined);
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * Public turn API
 * ──────────────────────────────────────────────────────────────────────── */

export type EgressRecordingApi = {
  readonly turnId: string;
  readonly subjectId: string;
  readonly deviceId: string;
  readonly principalId: string;
  /** Tag nested work so egress inherits this payload class marker. */
  withPayloadClass: <T>(
    marker: PayloadClassMarker,
    fn: () => Promise<T> | T,
  ) => Promise<T>;
  currentPayloadClass: () => PayloadClassMarker;
  records: () => readonly EgressAttemptRecord[];
  /**
   * Default MockAgent when the turn owns one — register intercepts here so
   * tests never hit the public internet.
   */
  mockAgent: () => MockAgent | null;
};

export type EgressTurnRecord = {
  turnId: string;
  subjectId: string;
  deviceId: string;
  principalId: string;
  attempts: readonly EgressAttemptRecord[];
  /** True when the turn produced no recorded egress (on-device-shaped). */
  noEgress: boolean;
};

export type EgressTurnResult<T> = {
  value: T;
  turn: EgressTurnRecord;
};

export type EgressRecordingOptions = {
  subjectId: string;
  deviceId: string;
  caller: LocalityCallerBinding;
  /** Hostnames treated as self-hosted (normalized case-insensitively). */
  selfHostedHosts?: readonly string[];
  deadlineMs?: number;
  maxRecords?: number;
  /**
   * Downstream undici dispatcher. Default: fresh MockAgent with
   * `disableNetConnect()` so tests stay offline unless intercepts are added.
   */
  downstream?: Dispatcher;
  emit?: (event: LocalityEgressEvent) => void;
};

/**
 * Run `body` under an instrumented undici global dispatcher.
 *
 * Concurrent turns for different `subjectId`s share the process dispatcher
 * but isolate records via AsyncLocalStorage. Every egress attempt observed at
 * the undici seam is appended to the turn's attempt list (bounded).
 */
export async function withEgressRecordingTurn<T>(
  options: EgressRecordingOptions,
  body: (api: EgressRecordingApi) => Promise<T>,
): Promise<EgressTurnResult<T>> {
  const subjectId = options.subjectId.trim();
  const deviceId = options.deviceId.trim();
  const principalId = options.caller.principalId.trim();
  if (!subjectId) {
    throw new Error("subjectId is required for egress-recording turns");
  }
  if (!deviceId) {
    throw new Error("deviceId is required for egress-recording turns");
  }
  if (!principalId) {
    throw new Error("caller.principalId is required for egress-recording turns");
  }
  if (!callerAllowsSubject(options.caller, subjectId)) {
    options.emit?.({
      event: "locality.egress",
      subjectId,
      deviceId,
      turnId: "none",
      outcome: "caller_denied",
      principalId,
    });
    throw new EgressCallerDeniedError(principalId, subjectId);
  }

  const turnId = randomUUID();
  const deadlineMs = options.deadlineMs ?? DEFAULT_EGRESS_TURN_DEADLINE_MS;
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_EGRESS_RECORDS;
  const selfHostedHosts = new Set(
    (options.selfHostedHosts ?? []).map(normalizeEgressHost),
  );

  const state: TurnAlsState = {
    turnId,
    subjectId,
    deviceId,
    principalId,
    selfHostedHosts,
    records: [],
    maxRecords,
    payloadClass: "none",
    emit: options.emit,
    dropped: false,
  };

  let released = false;
  try {
    await withDispatcherSetupMutex(() => {
      // Concurrent turns share one process-global recorder. Prefer an
      // already-installed MockAgent so intercepts stay reachable.
      let downstream = options.downstream;
      if (!downstream) {
        downstream = globalRecorder?.mock ?? undefined;
      }
      if (!downstream) {
        const mock = new MockAgent();
        mock.disableNetConnect();
        downstream = mock;
      }
      installGlobalRecorder(downstream);
    });
    options.emit?.({
      event: "locality.egress",
      subjectId,
      deviceId,
      turnId,
      outcome: "turn_start",
      principalId,
    });

    const api: EgressRecordingApi = {
      turnId,
      subjectId,
      deviceId,
      principalId,
      withPayloadClass: async (marker, fn) => {
        const prev = state.payloadClass;
        state.payloadClass = marker;
        try {
          return await fn();
        } finally {
          state.payloadClass = prev;
        }
      },
      currentPayloadClass: () => state.payloadClass,
      records: () => state.records.slice(),
      mockAgent: () => globalRecorder?.mock ?? null,
    };

    const value = await turnAls.run(state, () =>
      raceDeadline(
        Promise.resolve().then(() => body(api)),
        deadlineMs,
        () => {
          options.emit?.({
            event: "locality.egress",
            subjectId,
            deviceId,
            turnId,
            outcome: "deadline",
            principalId,
          });
          return new EgressTurnDeadlineError(turnId, deadlineMs);
        },
      ),
    );

    const turn: EgressTurnRecord = {
      turnId,
      subjectId,
      deviceId,
      principalId,
      attempts: state.records.slice(),
      noEgress: state.records.length === 0,
    };

    options.emit?.({
      event: "locality.egress",
      subjectId,
      deviceId,
      turnId,
      outcome: "turn_end",
      principalId,
    });

    return { value, turn };
  } finally {
    if (!released) {
      released = true;
      try {
        await withDispatcherSetupMutex(() => releaseGlobalRecorder());
      } catch {
        options.emit?.({
          event: "locality.egress",
          subjectId,
          deviceId,
          turnId,
          outcome: "teardown_error",
          principalId,
        });
      }
    }
  }
}

/**
 * Snapshot whether the current async context is inside an instrumented turn.
 * Useful for bindings that want to refuse work outside the harness.
 */
export function isInsideEgressRecordingTurn(): boolean {
  return turnAls.getStore() !== undefined;
}

/* ────────────────────────────────────────────────────────────────────────
 * Locality policy + assertion API + obligations
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Localities a data class may touch.
 * `third-party` is the destination class for ModelInterface `external-api`.
 * `on-device` means **no egress** (empty turn.attempts).
 */
export type AllowedLocality = "on-device" | "self-hosted" | "third-party";

export type LocalityPolicy = {
  /**
   * Payload / data class → localities permitted to receive it.
   * Missing keys fall back to {@link LocalityPolicy.defaultAllowed}.
   */
  allowedByDataClass: Readonly<
    Partial<Record<PayloadClassMarker, readonly AllowedLocality[]>>
  >;
  /** Fail-closed default when a class is absent from the map. */
  defaultAllowed: readonly AllowedLocality[];
};

/** Sovereign default: regulated / cognitive / prompts stay on-device or self-hosted. */
export const DEFAULT_SOVEREIGN_LOCALITY_POLICY: LocalityPolicy = {
  allowedByDataClass: {
    none: ["on-device", "self-hosted", "third-party"],
    metadata: ["on-device", "self-hosted", "third-party"],
    "cognitive-state": ["on-device", "self-hosted"],
    regulated: ["on-device", "self-hosted"],
    "model-prompt": ["on-device", "self-hosted"],
    /** Unknown class: on-device only (fail closed). */
    unknown: ["on-device"],
  },
  defaultAllowed: ["on-device"],
};

export type LocalityViolationCode =
  | "LOCALITY_FORBIDDEN_DESTINATION"
  | "LOCALITY_SUBJECT_MISMATCH"
  | "LOCALITY_ON_DEVICE_REQUIRED";

export type LocalityViolation = {
  code: LocalityViolationCode;
  subjectId: string;
  deviceId: string;
  turnId: string;
  payloadClass: PayloadClassMarker;
  destinationClass: EgressDestinationClass | "on-device";
  destinationHost: string | undefined;
  message: string;
};

export type LocalityAssertionResult = {
  ok: boolean;
  violations: readonly LocalityViolation[];
};

export type LocalityAssertEvent = {
  event: "locality.assert";
  subjectId: string;
  deviceId: string;
  turnId: string;
  outcome: "pass" | "fail";
  violationCount: number;
  codes: readonly LocalityViolationCode[];
};

/** Bound scan of egress attempts (matches recorder cap; no unbounded walk). */
export const LOCALITY_ASSERT_SCAN_LIMIT = DEFAULT_MAX_EGRESS_RECORDS;

export function allowedLocalitiesFor(
  policy: LocalityPolicy,
  dataClass: PayloadClassMarker,
): readonly AllowedLocality[] {
  const listed = policy.allowedByDataClass[dataClass];
  if (listed !== undefined) return listed;
  return policy.defaultAllowed;
}

export function destinationToAllowedLocality(
  destinationClass: EgressDestinationClass,
): AllowedLocality {
  return destinationClass;
}

/**
 * Assert a recorded turn against a data-class → locality policy.
 * Pure / idempotent: same `(turn, policy)` → same violation list.
 * Never inspects request bodies — markers + destination class only.
 */
export function assertLocality(
  turn: EgressTurnRecord,
  policy: LocalityPolicy,
  options?: {
    emit?: (event: LocalityAssertEvent) => void;
    scanLimit?: number;
  },
): LocalityAssertionResult {
  const scanLimit = options?.scanLimit ?? LOCALITY_ASSERT_SCAN_LIMIT;
  const violations: LocalityViolation[] = [];
  const attempts = turn.attempts.slice(0, scanLimit);

  for (const attempt of attempts) {
    if (attempt.initiator.subjectId !== turn.subjectId) {
      violations.push({
        code: "LOCALITY_SUBJECT_MISMATCH",
        subjectId: turn.subjectId,
        deviceId: turn.deviceId,
        turnId: turn.turnId,
        payloadClass: attempt.payloadClass,
        destinationClass: attempt.destinationClass,
        destinationHost: attempt.destinationHost,
        message: `egress initiator subjectId '${attempt.initiator.subjectId}' does not match turn subjectId '${turn.subjectId}'`,
      });
      continue;
    }

    const allowed = allowedLocalitiesFor(policy, attempt.payloadClass);
    const actual = destinationToAllowedLocality(attempt.destinationClass);
    if (!allowed.includes(actual)) {
      const code: LocalityViolationCode =
        allowed.length === 1 && allowed[0] === "on-device"
          ? "LOCALITY_ON_DEVICE_REQUIRED"
          : "LOCALITY_FORBIDDEN_DESTINATION";
      violations.push({
        code,
        subjectId: turn.subjectId,
        deviceId: turn.deviceId,
        turnId: turn.turnId,
        payloadClass: attempt.payloadClass,
        destinationClass: attempt.destinationClass,
        destinationHost: attempt.destinationHost,
        message: `payload class '${attempt.payloadClass}' reached '${actual}' host '${attempt.destinationHost}' but policy allows: [${allowed.join(", ")}]`,
      });
    }
  }

  const result: LocalityAssertionResult = {
    ok: violations.length === 0,
    violations,
  };

  options?.emit?.({
    event: "locality.assert",
    subjectId: turn.subjectId,
    deviceId: turn.deviceId,
    turnId: turn.turnId,
    outcome: result.ok ? "pass" : "fail",
    violationCount: violations.length,
    codes: violations.map((v) => v.code),
  });

  return result;
}

/** Verbatim MUST from `@moolam/contracts` ModelInterface (CK-03.3). */
export const MUST_LOCALITY_GATE_PER_DATA_CLASS =
  "Providers MUST surface `locality` truthfully — sovereign deployments gate which localities are permitted per data class.";

export const LOCALITY_OBLIGATION_IDS = {
  /** Regulated (and cognitive-state) payloads must not hit third-party. */
  regulatedStaysLocal: "CK-03.L1",
  /** Every egress initiator subjectId must equal the turn subjectId. */
  subjectBoundEgress: "CK-03.L2",
} as const;

/**
 * Conformance surface for locality policy obligations.
 * `captureTurn` must return a recorder turn (001); assertions run in checks.
 */
export type LocalityConformanceHarness = {
  policy: LocalityPolicy;
  captureTurn: (ctx: ObligationContext) => Promise<EgressTurnRecord>;
};

export function defineRegulatedStaysLocalObligation(): Obligation<LocalityConformanceHarness> {
  return defineObligation({
    id: LOCALITY_OBLIGATION_IDS.regulatedStaysLocal,
    contract: "ModelInterface",
    mustText: MUST_LOCALITY_GATE_PER_DATA_CLASS,
    specIds: ["CK-03"],
    async check(impl, ctx) {
      const turn = await impl.captureTurn(ctx);
      if (turn.subjectId !== ctx.subjectId) {
        throw new ObligationViolation({
          obligationId: LOCALITY_OBLIGATION_IDS.regulatedStaysLocal,
          mustText: MUST_LOCALITY_GATE_PER_DATA_CLASS,
          contract: "ModelInterface",
          message: `turn subjectId '${turn.subjectId}' does not match obligation subjectId '${ctx.subjectId}'`,
        });
      }
      const asserted = assertLocality(turn, impl.policy, {
        emit: (event) => {
          ctx.emit({
            event: "conformance.obligation",
            obligationId: LOCALITY_OBLIGATION_IDS.regulatedStaysLocal,
            outcome: event.outcome === "pass" ? "pass" : "fail",
            subjectId: ctx.subjectId,
            ...(ctx.deviceId !== undefined ? { deviceId: ctx.deviceId } : {}),
            contract: "ModelInterface",
          });
        },
      });
      const forbidden = asserted.violations.filter(
        (v) =>
          (v.payloadClass === "regulated" ||
            v.payloadClass === "cognitive-state" ||
            v.payloadClass === "model-prompt") &&
          (v.code === "LOCALITY_FORBIDDEN_DESTINATION" ||
            v.code === "LOCALITY_ON_DEVICE_REQUIRED"),
      );
      if (forbidden.length > 0) {
        const first = forbidden[0]!;
        throw new ObligationViolation({
          obligationId: LOCALITY_OBLIGATION_IDS.regulatedStaysLocal,
          mustText: MUST_LOCALITY_GATE_PER_DATA_CLASS,
          contract: "ModelInterface",
          message: first.message,
        });
      }
    },
  });
}

export function defineSubjectBoundEgressObligation(): Obligation<LocalityConformanceHarness> {
  return defineObligation({
    id: LOCALITY_OBLIGATION_IDS.subjectBoundEgress,
    contract: "ModelInterface",
    mustText: MUST_LOCALITY_GATE_PER_DATA_CLASS,
    specIds: ["CK-03"],
    async check(impl, ctx) {
      const turn = await impl.captureTurn(ctx);
      if (turn.subjectId !== ctx.subjectId) {
        throw new ObligationViolation({
          obligationId: LOCALITY_OBLIGATION_IDS.subjectBoundEgress,
          mustText: MUST_LOCALITY_GATE_PER_DATA_CLASS,
          contract: "ModelInterface",
          message: `turn subjectId '${turn.subjectId}' does not match obligation subjectId '${ctx.subjectId}'`,
        });
      }
      const asserted = assertLocality(turn, impl.policy);
      const mismatches = asserted.violations.filter(
        (v) => v.code === "LOCALITY_SUBJECT_MISMATCH",
      );
      if (mismatches.length > 0) {
        throw new ObligationViolation({
          obligationId: LOCALITY_OBLIGATION_IDS.subjectBoundEgress,
          mustText: MUST_LOCALITY_GATE_PER_DATA_CLASS,
          contract: "ModelInterface",
          message: mismatches[0]!.message,
        });
      }
    },
  });
}

export function registerRegulatedStaysLocalObligation(
  registry: ObligationRegistry,
): ObligationRegistry {
  registry.register(defineRegulatedStaysLocalObligation());
  return registry;
}

export function registerSubjectBoundEgressObligation(
  registry: ObligationRegistry,
): ObligationRegistry {
  registry.register(defineSubjectBoundEgressObligation());
  return registry;
}

export function registerLocalityPolicyObligations(
  registry: ObligationRegistry,
): ObligationRegistry {
  registerRegulatedStaysLocalObligation(registry);
  registerSubjectBoundEgressObligation(registry);
  return registry;
}

export function createLocalityPolicyObligationsRegistry(): ObligationRegistry {
  return registerLocalityPolicyObligations(new ObligationRegistry());
}

type LocalityHarnessMode = "compliant" | "regulated_third_party" | "cross_subject";

function createLocalityHarness(
  mode: LocalityHarnessMode,
  policy: LocalityPolicy = DEFAULT_SOVEREIGN_LOCALITY_POLICY,
): LocalityConformanceHarness {
  return {
    policy,
    async captureTurn(ctx) {
      const deviceId = ctx.deviceId ?? "dev-locality-policy";
      const { turn } = await withEgressRecordingTurn(
        {
          subjectId: ctx.subjectId,
          deviceId,
          caller: { principalId: "policy-probe", subjectScope: "*" },
          selfHostedHosts: ["school.local"],
          deadlineMs: ctx.deadlineMs,
        },
        async (api) => {
          const mock = api.mockAgent();
          if (!mock) {
            throw new Error("MockAgent required for locality policy probes");
          }
          mock
            .get("https://school.local")
            .intercept({ path: "/v1/sync", method: "POST" })
            .reply(204);
          mock
            .get("https://vendor.example")
            .intercept({ path: "/v1/infer", method: "POST" })
            .reply(200, { ok: true });

          if (mode === "compliant") {
            await api.withPayloadClass("regulated", async () => {
              await fetch("https://school.local/v1/sync", {
                method: "POST",
                body: "{}",
              });
            });
            return;
          }

          if (mode === "regulated_third_party") {
            await api.withPayloadClass("regulated", async () => {
              await fetch("https://vendor.example/v1/infer", {
                method: "POST",
                body: "{}",
              });
            });
            return;
          }

          // cross_subject: forge an attempt with a mismatched initiator via
          // a post-capture mutation of the turn record returned below — capture
          // a normal self-hosted regulated call, then the factory wrapper
          // rewrites subject binding. Handled in the factory below.
          await api.withPayloadClass("metadata", async () => {
            await fetch("https://school.local/v1/sync", {
              method: "POST",
              body: "{}",
            });
          });
        },
      );

      if (mode === "cross_subject") {
        return {
          ...turn,
          attempts: turn.attempts.map((a) => ({
            ...a,
            initiator: {
              ...a.initiator,
              subjectId: `${ctx.subjectId}::peer`,
            },
          })),
        };
      }
      return turn;
    },
  };
}

/** Known-good: regulated payload stays on self-hosted allowlist. */
export function createCompliantLocalityHarnessFactory(): ImplementationFactory<LocalityConformanceHarness> {
  return (_ctx: FactoryContext) => createLocalityHarness("compliant");
}

/** Seeded violation for CK-03.L1: regulated egress to third-party. */
export function createRegulatedThirdPartyViolationFactory(): ImplementationFactory<LocalityConformanceHarness> {
  return (_ctx: FactoryContext) => createLocalityHarness("regulated_third_party");
}

/** Seeded violation for CK-03.L2: initiator subjectId ≠ turn subjectId. */
export function createCrossSubjectEgressViolationFactory(): ImplementationFactory<LocalityConformanceHarness> {
  return (_ctx: FactoryContext) => createLocalityHarness("cross_subject");
}

/* ────────────────────────────────────────────────────────────────────────
 * Learning-path consent gates
 * ──────────────────────────────────────────────────────────────────────── */

export const LEARNING_PATH_LOCALITY_OBLIGATION_IDS = {
  aggregationConsentBeforeEgress: "CK-03.L3",
  trajectoryConsentBeforeExport: "CK-03.L4",
} as const;

export type LearningPathLocalityConformanceHarness = {
  /**
   * Exercise the aggregation egress path with no consent. A conforming
   * implementation refuses before network I/O and returns a zero-egress turn.
   */
  captureAggregationWithoutConsent: (
    ctx: ObligationContext,
  ) => Promise<EgressTurnRecord>;
  /**
   * Exercise trajectory export with no export consent. Hash-only payloads are
   * still regulated markers and must be refused before network I/O.
   */
  captureTrajectoryWithoutConsent: (
    ctx: ObligationContext,
  ) => Promise<EgressTurnRecord>;
};

export type LearningPathProbe = "aggregation" | "trajectory";

export const LEARNING_PATH_REGULATED_CLASSES = [
  "health",
  "legal",
  "minor-learner",
] as const;

export type LearningPathRegulatedClass =
  (typeof LEARNING_PATH_REGULATED_CLASSES)[number];

export type LearningPathProbeEvent = {
  event: "locality.learning_path";
  path: LearningPathProbe;
  regulatedClass: LearningPathRegulatedClass;
  subjectId: string;
  deviceId: string;
  outcome: "local_probe" | "egress_attempt";
  payloadClass: "regulated";
};

function assertLearningPathBlockedBeforeEgress(
  turn: EgressTurnRecord,
  ctx: ObligationContext,
  obligationId: string,
  path: LearningPathProbe,
): void {
  if (turn.subjectId !== ctx.subjectId) {
    throw new ObligationViolation({
      obligationId,
      mustText: MUST_LOCALITY_GATE_PER_DATA_CLASS,
      contract: "ModelInterface",
      message: `${path} probe subjectId '${turn.subjectId}' does not match obligation subjectId '${ctx.subjectId}'`,
    });
  }
  const mismatch = turn.attempts.find(
    (attempt) => attempt.initiator.subjectId !== ctx.subjectId,
  );
  if (mismatch !== undefined) {
    throw new ObligationViolation({
      obligationId,
      mustText: MUST_LOCALITY_GATE_PER_DATA_CLASS,
      contract: "ModelInterface",
      message: `${path} egress was attributed to another subject`,
    });
  }
  if (turn.attempts.length > 0) {
    const first = turn.attempts[0]!;
    throw new ObligationViolation({
      obligationId,
      mustText: MUST_LOCALITY_GATE_PER_DATA_CLASS,
      contract: "ModelInterface",
      message: `${path} attempted ${first.payloadClass} egress to '${first.destinationHost}' before required consent`,
    });
  }
}

export function defineAggregationConsentBeforeEgressObligation(): Obligation<LearningPathLocalityConformanceHarness> {
  return defineObligation({
    id: LEARNING_PATH_LOCALITY_OBLIGATION_IDS.aggregationConsentBeforeEgress,
    contract: "ModelInterface",
    mustText: MUST_LOCALITY_GATE_PER_DATA_CLASS,
    specIds: ["CK-03", "CAST-01"],
    async check(impl, ctx) {
      const turn = await impl.captureAggregationWithoutConsent(ctx);
      assertLearningPathBlockedBeforeEgress(
        turn,
        ctx,
        LEARNING_PATH_LOCALITY_OBLIGATION_IDS.aggregationConsentBeforeEgress,
        "aggregation",
      );
    },
  });
}

export function defineTrajectoryConsentBeforeExportObligation(): Obligation<LearningPathLocalityConformanceHarness> {
  return defineObligation({
    id: LEARNING_PATH_LOCALITY_OBLIGATION_IDS.trajectoryConsentBeforeExport,
    contract: "ModelInterface",
    mustText: MUST_LOCALITY_GATE_PER_DATA_CLASS,
    specIds: ["CK-03"],
    async check(impl, ctx) {
      const turn = await impl.captureTrajectoryWithoutConsent(ctx);
      assertLearningPathBlockedBeforeEgress(
        turn,
        ctx,
        LEARNING_PATH_LOCALITY_OBLIGATION_IDS.trajectoryConsentBeforeExport,
        "trajectory",
      );
    },
  });
}

export function registerLearningPathLocalityObligations(
  registry: ObligationRegistry,
): ObligationRegistry {
  registry.register(defineAggregationConsentBeforeEgressObligation());
  registry.register(defineTrajectoryConsentBeforeExportObligation());
  return registry;
}

export function createLearningPathLocalityObligationsRegistry(): ObligationRegistry {
  return registerLearningPathLocalityObligations(new ObligationRegistry());
}

type LearningPathHarnessMode =
  | "compliant"
  | "aggregation_egress_without_consent"
  | "trajectory_egress_without_consent";

function createLearningPathLocalityHarness(
  mode: LearningPathHarnessMode,
  options: {
    regulatedClass?: LearningPathRegulatedClass;
    emit?: (event: LearningPathProbeEvent) => void;
  } = {},
): LearningPathLocalityConformanceHarness {
  const regulatedClass = options.regulatedClass ?? "health";
  const capture = async (
    path: LearningPathProbe,
    ctx: ObligationContext,
  ): Promise<EgressTurnRecord> => {
    const deviceId = ctx.deviceId ?? "dev-learning-locality";
    const { turn } = await withEgressRecordingTurn(
      {
        subjectId: ctx.subjectId,
        deviceId,
        caller: {
          principalId: "learning-locality-probe",
          subjectScope: [ctx.subjectId],
        },
        selfHostedHosts: ["learning.local"],
        deadlineMs: ctx.deadlineMs,
      },
      async (api) => {
        const shouldEgress =
          (path === "aggregation" &&
            mode === "aggregation_egress_without_consent") ||
          (path === "trajectory" &&
            mode === "trajectory_egress_without_consent");
        await api.withPayloadClass("regulated", async () => {
          options.emit?.({
            event: "locality.learning_path",
            path,
            regulatedClass,
            subjectId: ctx.subjectId,
            deviceId,
            outcome: "local_probe",
            payloadClass: "regulated",
          });
          if (!shouldEgress) return;

          const mock = api.mockAgent();
          if (!mock) {
            throw new Error("MockAgent required for learning locality probes");
          }
          mock
            .get("https://vendor.example")
            .intercept({
              path: path === "aggregation" ? "/v1/aggregate" : "/v1/trajectory",
              method: "POST",
            })
            .reply(202, { accepted: true });
          options.emit?.({
            event: "locality.learning_path",
            path,
            regulatedClass,
            subjectId: ctx.subjectId,
            deviceId,
            outcome: "egress_attempt",
            payloadClass: "regulated",
          });
          await fetch(
            path === "aggregation"
              ? "https://vendor.example/v1/aggregate"
              : "https://vendor.example/v1/trajectory",
            { method: "POST", body: "{}" },
          );
        });
      },
    );
    return turn;
  };

  return {
    captureAggregationWithoutConsent: (ctx) => capture("aggregation", ctx),
    captureTrajectoryWithoutConsent: (ctx) => capture("trajectory", ctx),
  };
}

/** Known-good: both learning paths refuse before egress when consent is absent. */
export function createCompliantLearningPathLocalityFactory(): ImplementationFactory<LearningPathLocalityConformanceHarness> {
  return (_ctx: FactoryContext) => createLearningPathLocalityHarness("compliant");
}

/** Seeded violation: aggregation attempts network egress before consent. */
export function createAggregationWithoutConsentViolationFactory(): ImplementationFactory<LearningPathLocalityConformanceHarness> {
  return (_ctx: FactoryContext) =>
    createLearningPathLocalityHarness("aggregation_egress_without_consent");
}

/** Seeded violation: regulated trajectory hashes egress before export consent. */
export function createTrajectoryWithoutConsentViolationFactory(): ImplementationFactory<LearningPathLocalityConformanceHarness> {
  return (_ctx: FactoryContext) =>
    createLearningPathLocalityHarness("trajectory_egress_without_consent");
}

/**
 * Red-team factory for bounded regulated-class probes. Probe values are class
 * labels only; no learner/user content is accepted or emitted.
 */
export function createRegulatedLearningPathRedTeamFactory(options: {
  regulatedClass: LearningPathRegulatedClass;
  violatePath?: LearningPathProbe;
  emit?: (event: LearningPathProbeEvent) => void;
}): ImplementationFactory<LearningPathLocalityConformanceHarness> {
  const mode: LearningPathHarnessMode =
    options.violatePath === "aggregation"
      ? "aggregation_egress_without_consent"
      : options.violatePath === "trajectory"
        ? "trajectory_egress_without_consent"
        : "compliant";
  return (_ctx: FactoryContext) =>
    createLearningPathLocalityHarness(mode, {
      regulatedClass: options.regulatedClass,
      ...(options.emit === undefined ? {} : { emit: options.emit }),
    });
}
