/**
 * Session durable-state schema and store interface (two-tier rehydration).
 *
 * Versioned blob: profile snapshot, active plan, compaction summary, and
 * correction refs. Rehydration loads this durable tier only — no requirement
 * to replay every historical turn message. Correction-kind memories always
 * rehydrate; episodic detail may remain summarized.
 *
 * Backends implement {@link SessionDurableStore}. Hosts select via
 * {@link selectSessionDurableStore} (env) — in-memory for tests, file for
 * process-restart durability. Active backend is logged once at selection.
 *
 * Sovereignty: telemetry carries subjectId / sessionId / outcome — never
 * profile charter, plan rationale, summary text, or correction plaintext.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ChatMessage, Plan } from "@moolam/contracts";
import {
  ContextBudgetManager,
  type ContextBudgetSnapshot,
  type ContextMemoryItem,
} from "./context_budget.js";

/** Protocol version embedded in every durable blob. */
export const SESSION_DURABLE_PROTOCOL_VERSION = "1.0.0" as const;

/** Soft cap on correction refs retained in the durable tier. */
export const SESSION_CORRECTION_REF_LIMIT = 64;

/** Soft cap on UTF-16 code units per text field in the blob. */
export const SESSION_DURABLE_SECTION_CHAR_LIMIT = 32_768;

/** Soft cap on in-memory store entries (subject×session). */
export const SESSION_STORE_ENTRY_LIMIT = 256;

/** Milliseconds in one UTC day — days-gap integration clock math. */
export const SESSION_DAY_MS = 86_400_000;

/** Env key: `memory` (default) | `file`. */
export const SESSION_STORE_BACKEND_ENV = "SUTRA_SESSION_STORE_BACKEND";

/** Env key: directory for the file backend. */
export const SESSION_STORE_PATH_ENV = "SUTRA_SESSION_STORE_PATH";

export type SessionDurableBackendName = "memory" | "file";

export type SessionDurableFailureClass =
  | "missing_subject"
  | "missing_session"
  | "cross_subject"
  | "invalid_state"
  | "corrupted"
  | "version_mismatch"
  | "stale_state_vector"
  | "sync_in_flight"
  | "section_limit"
  | "not_found"
  | "backend_error";

/** Advisory when durable state is missing/corrupt — start clean, do not crash. */
export const SESSION_ADVISORY_CLEAN_SESSION = "clean_session" as const;

export type SessionDurableAdvisoryCode =
  typeof SESSION_ADVISORY_CLEAN_SESSION;

/**
 * Profile fields persisted on the durable tier.
 * Mirrors cognitive-core AgentProfile snapshot (no package edge).
 */
export type SessionProfileSnapshot = {
  domainId: string;
  charter: string;
  refusals: string[];
  languages: string[];
};

/** Correction-kind memory retained across rehydration. */
export type SessionCorrectionRef = {
  memoryId: string;
  /** Always "correction" on the durable tier. */
  kind: "correction";
  /** Verbatim correction text for rehydrate — never echoed in telemetry. */
  text: string;
};

/**
 * Versioned durable session blob — profile, plan, compaction summary,
 * correction refs. Episodic history is not required.
 */
export type SessionDurableState = {
  protocolVersion: typeof SESSION_DURABLE_PROTOCOL_VERSION | string;
  subjectId: string;
  sessionId: string;
  deviceId?: string;
  /**
   * Optimistic concurrency token. Puts must supply the previously read
   * vector; stale writes are rejected (never last-write-wins).
   */
  stateVector: number;
  profile: SessionProfileSnapshot;
  activePlan: Plan | null;
  /** Compiled compaction summary bytes, or null when none yet. */
  compactionSummary: string | null;
  /** SHA-256 of compactionSummary when present. */
  summaryHash?: string;
  /** Correction-kind memories — always rehydrate. */
  correctionRefs: SessionCorrectionRef[];
  /**
   * Host/wall clock when the blob was last committed (ms since epoch).
   * Used for days-gap rehydration telemetry — never gates availability.
   */
  updatedAtMs?: number;
};

export type SessionDurableTelemetryEvent = {
  event: "runtime.harness.session_store";
  outcome: "ok" | "rejected" | "advisory";
  subjectId: string | null;
  sessionId: string | null;
  deviceId?: string;
  action?:
    | "get"
    | "put"
    | "delete"
    | "validate"
    | "select_backend"
    | "migrate"
    | "rehydrate";
  backend?: SessionDurableBackendName;
  status?:
    | "found"
    | "not_found"
    | "empty"
    | "written"
    | "deleted"
    | "idempotent";
  stateVector?: number;
  correctionCount?: number;
  hasPlan?: boolean;
  hasSummary?: boolean;
  /** Whole days between updatedAtMs and rehydrate nowMs (clock inject). */
  daysSinceWrite?: number;
  updatedAtMs?: number;
  advisory?: SessionDurableAdvisoryCode;
  failureClass?: SessionDurableFailureClass;
};

export type SessionStoreGetFound = {
  ok: true;
  status: "found";
  state: SessionDurableState;
  subjectId: string;
  sessionId: string;
  deviceId?: string;
};

/** Never written for this subject×session. */
export type SessionStoreGetNotFound = {
  ok: true;
  status: "not_found";
  subjectId: string;
  sessionId: string;
  advisory: typeof SESSION_ADVISORY_CLEAN_SESSION;
};

/**
 * Explicit empty durable record (valid blob with no plan/summary/corrections).
 * Distinct from {@link SessionStoreGetNotFound}.
 */
export type SessionStoreGetEmpty = {
  ok: true;
  status: "empty";
  state: SessionDurableState;
  subjectId: string;
  sessionId: string;
  advisory: typeof SESSION_ADVISORY_CLEAN_SESSION;
};

/** Corrupted / unreadable — start clean with advisory, never throw. */
export type SessionStoreGetCorruptedAdvisory = {
  ok: true;
  status: "corrupted_advisory";
  subjectId: string;
  sessionId: string;
  advisory: typeof SESSION_ADVISORY_CLEAN_SESSION;
  failureClass: "corrupted" | "version_mismatch";
  detail: string;
};

export type SessionStoreGetRejected = {
  ok: false;
  failureClass: SessionDurableFailureClass;
  subjectId: string | null;
  sessionId: string | null;
  detail: string;
};

export type SessionStoreGetResult =
  | SessionStoreGetFound
  | SessionStoreGetNotFound
  | SessionStoreGetEmpty
  | SessionStoreGetCorruptedAdvisory
  | SessionStoreGetRejected;

export type SessionStorePutAccepted = {
  ok: true;
  subjectId: string;
  sessionId: string;
  deviceId?: string;
  stateVector: number;
  idempotent?: boolean;
};

export type SessionStorePutRejected = {
  ok: false;
  failureClass: SessionDurableFailureClass;
  subjectId: string | null;
  sessionId: string | null;
  detail: string;
};

export type SessionStorePutResult =
  | SessionStorePutAccepted
  | SessionStorePutRejected;

export type SessionStoreDeleteAccepted = {
  ok: true;
  subjectId: string;
  sessionId: string;
  deleted: boolean;
};

export type SessionStoreDeleteResult =
  | SessionStoreDeleteAccepted
  | SessionStorePutRejected;

export type SessionStoreOpOptions = {
  /** When true, refuse mutate/read with typed sync_in_flight (wait for Track A merge). */
  syncInFlight?: boolean;
  expectedStateVector?: number;
};

/**
 * Durable session store contract — memory and file backends.
 * Empty vs not-found are distinct get outcomes.
 */
export interface SessionDurableStore {
  readonly backendName: SessionDurableBackendName;
  get(
    subjectId: string,
    sessionId: string,
    options?: SessionStoreOpOptions,
  ): SessionStoreGetResult;
  put(
    state: SessionDurableState,
    options?: SessionStoreOpOptions,
  ): SessionStorePutResult;
  delete(
    subjectId: string,
    sessionId: string,
    options?: SessionStoreOpOptions,
  ): SessionStoreDeleteResult;
}

export type SelectSessionDurableStoreOptions = {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  /** Required when backend is `file` and env path is unset. */
  rootDir?: string;
  onTelemetry?: (event: SessionDurableTelemetryEvent) => void;
  /** Optional logger — selection emits once. */
  log?: (message: string) => void;
};

let backendSelectionLogged = false;

/**
 * Select session store backend from env (`SUTRA_SESSION_STORE_BACKEND`).
 * Defaults to in-memory. Logs the active backend once per process.
 */
export function selectSessionDurableStore(
  options: SelectSessionDurableStoreOptions = {},
): SessionDurableStore {
  const env = options.env ?? process.env;
  const raw = trimStr(env[SESSION_STORE_BACKEND_ENV]).toLowerCase() || "memory";
  const backend: SessionDurableBackendName =
    raw === "file" ? "file" : "memory";

  let store: SessionDurableStore;
  if (backend === "file") {
    const root =
      trimStr(options.rootDir) ||
      trimStr(env[SESSION_STORE_PATH_ENV]) ||
      "";
    if (!root) {
      throw new Error(
        `file session store requires ${SESSION_STORE_PATH_ENV} or rootDir`,
      );
    }
    store = new FileSessionDurableStore({
      rootDir: root,
      ...(options.onTelemetry !== undefined
        ? { onTelemetry: options.onTelemetry }
        : {}),
    });
  } else {
    store = new InMemorySessionDurableStore({
      ...(options.onTelemetry !== undefined
        ? { onTelemetry: options.onTelemetry }
        : {}),
    });
  }

  if (!backendSelectionLogged) {
    backendSelectionLogged = true;
    const msg = `session_store_backend=${store.backendName} outcome=selected`;
    if (options.log) {
      options.log(msg);
    } else {
      process.stderr.write(`${msg}\n`);
    }
    options.onTelemetry?.({
      event: "runtime.harness.session_store",
      outcome: "ok",
      subjectId: null,
      sessionId: null,
      action: "select_backend",
      backend: store.backendName,
    });
  }

  return store;
}

/** Test helper — allow re-logging backend selection. */
export function resetSessionDurableStoreSelectionLogForTests(): void {
  backendSelectionLogged = false;
}

export type InMemorySessionDurableStoreOptions = {
  onTelemetry?: (event: SessionDurableTelemetryEvent) => void;
  maxEntries?: number;
};

/**
 * In-memory durable store for unit tests / zero-infra. Process restart
 * clears entries — use {@link FileSessionDurableStore} for restart tests.
 */
export class InMemorySessionDurableStore implements SessionDurableStore {
  readonly backendName: SessionDurableBackendName = "memory";
  private readonly entries = new Map<string, string>();
  private readonly onTelemetry:
    | ((event: SessionDurableTelemetryEvent) => void)
    | undefined;
  private readonly maxEntries: number;

  constructor(options: InMemorySessionDurableStoreOptions = {}) {
    this.onTelemetry = options.onTelemetry;
    this.maxEntries = options.maxEntries ?? SESSION_STORE_ENTRY_LIMIT;
  }

  get(
    subjectId: string,
    sessionId: string,
    options?: SessionStoreOpOptions,
  ): SessionStoreGetResult {
    return getFromSerialized(
      this.entries.get(storeKey(subjectId, sessionId)),
      subjectId,
      sessionId,
      options,
      this.onTelemetry,
      this.backendName,
    );
  }

  put(
    state: SessionDurableState,
    options?: SessionStoreOpOptions,
  ): SessionStorePutResult {
    return putSerialized(
      state,
      options,
      {
        read: (key) => this.entries.get(key),
        write: (key, value) => {
          if (
            !this.entries.has(key) &&
            this.entries.size >= this.maxEntries
          ) {
            return {
              ok: false as const,
              detail: `session store entry limit ${this.maxEntries}`,
            };
          }
          this.entries.set(key, value);
          return { ok: true as const };
        },
      },
      this.onTelemetry,
      this.backendName,
    );
  }

  delete(
    subjectId: string,
    sessionId: string,
    options?: SessionStoreOpOptions,
  ): SessionStoreDeleteResult {
    return deleteSerialized(
      subjectId,
      sessionId,
      options,
      {
        read: (key) => this.entries.get(key),
        remove: (key) => this.entries.delete(key),
      },
      this.onTelemetry,
      this.backendName,
    );
  }

  /** Test introspection — entry count. */
  get size(): number {
    return this.entries.size;
  }
}

export type FileSessionDurableStoreOptions = {
  rootDir: string;
  onTelemetry?: (event: SessionDurableTelemetryEvent) => void;
};

/**
 * File-backed durable store — survives process restart (write → kill → read).
 * One JSON file per subject×session under rootDir.
 */
export class FileSessionDurableStore implements SessionDurableStore {
  readonly backendName: SessionDurableBackendName = "file";
  private readonly rootDir: string;
  private readonly onTelemetry:
    | ((event: SessionDurableTelemetryEvent) => void)
    | undefined;

  constructor(options: FileSessionDurableStoreOptions) {
    const root = trimStr(options.rootDir);
    if (!root) {
      throw new Error("FileSessionDurableStore requires non-empty rootDir");
    }
    this.rootDir = root;
    this.onTelemetry = options.onTelemetry;
    mkdirSync(this.rootDir, { recursive: true });
  }

  private pathFor(subjectId: string, sessionId: string): string {
    const safeSubject = safePathSegment(subjectId);
    const safeSession = safePathSegment(sessionId);
    return join(this.rootDir, safeSubject, `${safeSession}.json`);
  }

  get(
    subjectId: string,
    sessionId: string,
    options?: SessionStoreOpOptions,
  ): SessionStoreGetResult {
    const sid = trimStr(subjectId);
    const sess = trimStr(sessionId);
    if (!sid || !sess) {
      return scopeRejectGet(sid, sess);
    }
    const path = this.pathFor(sid, sess);
    let raw: string | undefined;
    if (existsSync(path)) {
      try {
        raw = readFileSync(path, "utf8");
      } catch (err) {
        this.onTelemetry?.({
          event: "runtime.harness.session_store",
          outcome: "advisory",
          subjectId: sid,
          sessionId: sess,
          action: "get",
          backend: this.backendName,
          status: "not_found",
          advisory: SESSION_ADVISORY_CLEAN_SESSION,
          failureClass: "corrupted",
        });
        return {
          ok: true,
          status: "corrupted_advisory",
          subjectId: sid,
          sessionId: sess,
          advisory: SESSION_ADVISORY_CLEAN_SESSION,
          failureClass: "corrupted",
          detail: err instanceof Error ? err.message : "file read failed",
        };
      }
    }
    return getFromSerialized(
      raw,
      sid,
      sess,
      options,
      this.onTelemetry,
      this.backendName,
    );
  }

  put(
    state: SessionDurableState,
    options?: SessionStoreOpOptions,
  ): SessionStorePutResult {
    return putSerialized(
      state,
      options,
      {
        read: (key) => {
          const [subjectId, sessionId] = key.split("\0");
          const path = this.pathFor(subjectId!, sessionId!);
          if (!existsSync(path)) return undefined;
          try {
            return readFileSync(path, "utf8");
          } catch {
            return undefined;
          }
        },
        write: (key, value) => {
          const [subjectId, sessionId] = key.split("\0");
          const path = this.pathFor(subjectId!, sessionId!);
          try {
            mkdirSync(dirname(path), { recursive: true });
            const tmp = `${path}.tmp`;
            writeFileSync(tmp, value, "utf8");
            renameSync(tmp, path);
            return { ok: true as const };
          } catch (err) {
            return {
              ok: false as const,
              detail:
                err instanceof Error ? err.message : "file write failed",
            };
          }
        },
      },
      this.onTelemetry,
      this.backendName,
    );
  }

  delete(
    subjectId: string,
    sessionId: string,
    options?: SessionStoreOpOptions,
  ): SessionStoreDeleteResult {
    return deleteSerialized(
      subjectId,
      sessionId,
      options,
      {
        read: (key) => {
          const [sid, sess] = key.split("\0");
          const path = this.pathFor(sid!, sess!);
          if (!existsSync(path)) return undefined;
          try {
            return readFileSync(path, "utf8");
          } catch {
            return undefined;
          }
        },
        remove: (key) => {
          const [sid, sess] = key.split("\0");
          const path = this.pathFor(sid!, sess!);
          try {
            if (existsSync(path)) {
              unlinkSync(path);
              return true;
            }
            return false;
          } catch {
            return false;
          }
        },
      },
      this.onTelemetry,
      this.backendName,
    );
  }
}

/**
 * Build a minimal durable state for a new session (stateVector 0).
 */
export function createEmptySessionDurableState(input: {
  subjectId: string;
  sessionId: string;
  profile: SessionProfileSnapshot;
  deviceId?: string;
  updatedAtMs?: number;
}): SessionDurableState {
  return {
    protocolVersion: SESSION_DURABLE_PROTOCOL_VERSION,
    subjectId: trimStr(input.subjectId),
    sessionId: trimStr(input.sessionId),
    ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
    stateVector: 0,
    profile: normalizeProfile(input.profile),
    activePlan: null,
    compactionSummary: null,
    correctionRefs: [],
    ...(input.updatedAtMs !== undefined
      ? { updatedAtMs: input.updatedAtMs }
      : {}),
  };
}

/**
 * Validate and normalize a durable blob. Untrusted wire / disk input.
 */
export function parseSessionDurableState(
  raw: unknown,
):
  | { ok: true; state: SessionDurableState }
  | {
      ok: false;
      failureClass: Exclude<
        SessionDurableFailureClass,
        "not_found" | "stale_state_vector" | "sync_in_flight" | "backend_error"
      >;
      detail: string;
    } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      failureClass: "corrupted",
      detail: "durable blob must be a JSON object",
    };
  }
  const obj = raw as Record<string, unknown>;
  const protocolVersion = trimStr(obj.protocolVersion);
  if (!protocolVersion) {
    return {
      ok: false,
      failureClass: "corrupted",
      detail: "protocolVersion required",
    };
  }
  if (protocolVersion !== SESSION_DURABLE_PROTOCOL_VERSION) {
    return {
      ok: false,
      failureClass: "version_mismatch",
      detail: `unsupported protocolVersion '${protocolVersion}' (expected ${SESSION_DURABLE_PROTOCOL_VERSION})`,
    };
  }
  const subjectId = trimStr(obj.subjectId);
  if (!subjectId) {
    return {
      ok: false,
      failureClass: "missing_subject",
      detail: "subjectId required",
    };
  }
  const sessionId = trimStr(obj.sessionId);
  if (!sessionId) {
    return {
      ok: false,
      failureClass: "missing_session",
      detail: "sessionId required",
    };
  }
  if (
    typeof obj.stateVector !== "number" ||
    !Number.isInteger(obj.stateVector) ||
    obj.stateVector < 0
  ) {
    return {
      ok: false,
      failureClass: "invalid_state",
      detail: "stateVector must be a non-negative integer",
    };
  }
  const profileParsed = parseProfile(obj.profile);
  if (!profileParsed.ok) return profileParsed;

  let activePlan: Plan | null = null;
  if (obj.activePlan !== null && obj.activePlan !== undefined) {
    const planParsed = parsePlan(obj.activePlan);
    if (!planParsed.ok) return planParsed;
    activePlan = planParsed.plan;
  }

  let compactionSummary: string | null = null;
  if (obj.compactionSummary !== null && obj.compactionSummary !== undefined) {
    if (typeof obj.compactionSummary !== "string") {
      return {
        ok: false,
        failureClass: "invalid_state",
        detail: "compactionSummary must be a string or null",
      };
    }
    if (obj.compactionSummary.length > SESSION_DURABLE_SECTION_CHAR_LIMIT) {
      return {
        ok: false,
        failureClass: "section_limit",
        detail: `compactionSummary exceeds ${SESSION_DURABLE_SECTION_CHAR_LIMIT}`,
      };
    }
    compactionSummary = obj.compactionSummary;
  }

  let summaryHash: string | undefined;
  if (obj.summaryHash !== undefined) {
    if (typeof obj.summaryHash !== "string" || !/^[0-9a-f]{64}$/.test(obj.summaryHash)) {
      return {
        ok: false,
        failureClass: "invalid_state",
        detail: "summaryHash must be a 64-char hex digest when present",
      };
    }
    summaryHash = obj.summaryHash;
  }
  if (compactionSummary !== null && summaryHash === undefined) {
    summaryHash = createHash("sha256")
      .update(compactionSummary, "utf8")
      .digest("hex");
  }

  const corrections = parseCorrectionRefs(obj.correctionRefs);
  if (!corrections.ok) return corrections;

  let updatedAtMs: number | undefined;
  if (obj.updatedAtMs !== undefined) {
    if (
      typeof obj.updatedAtMs !== "number" ||
      !Number.isFinite(obj.updatedAtMs) ||
      !Number.isInteger(obj.updatedAtMs) ||
      obj.updatedAtMs < 0
    ) {
      return {
        ok: false,
        failureClass: "invalid_state",
        detail: "updatedAtMs must be a non-negative integer when present",
      };
    }
    updatedAtMs = obj.updatedAtMs;
  }

  const state: SessionDurableState = {
    protocolVersion: SESSION_DURABLE_PROTOCOL_VERSION,
    subjectId,
    sessionId,
    ...(typeof obj.deviceId === "string" ? { deviceId: obj.deviceId } : {}),
    stateVector: obj.stateVector,
    profile: profileParsed.profile,
    activePlan,
    compactionSummary,
    ...(summaryHash !== undefined ? { summaryHash } : {}),
    correctionRefs: corrections.refs,
    ...(updatedAtMs !== undefined ? { updatedAtMs } : {}),
  };
  return { ok: true, state };
}

function isEmptyDurable(state: SessionDurableState): boolean {
  return (
    state.activePlan === null &&
    state.compactionSummary === null &&
    state.correctionRefs.length === 0
  );
}

function storeKey(subjectId: string, sessionId: string): string {
  return `${trimStr(subjectId)}\0${trimStr(sessionId)}`;
}

function scopeRejectGet(
  subjectId: string,
  sessionId: string,
): SessionStoreGetRejected {
  if (!subjectId) {
    return {
      ok: false,
      failureClass: "missing_subject",
      subjectId: null,
      sessionId: sessionId || null,
      detail: "subjectId required",
    };
  }
  return {
    ok: false,
    failureClass: "missing_session",
    subjectId,
    sessionId: null,
    detail: "sessionId required",
  };
}

function getFromSerialized(
  raw: string | undefined,
  subjectId: string,
  sessionId: string,
  options: SessionStoreOpOptions | undefined,
  onTelemetry: ((e: SessionDurableTelemetryEvent) => void) | undefined,
  backend: SessionDurableBackendName,
): SessionStoreGetResult {
  const sid = trimStr(subjectId);
  const sess = trimStr(sessionId);
  if (!sid) {
    onTelemetry?.({
      event: "runtime.harness.session_store",
      outcome: "rejected",
      subjectId: null,
      sessionId: sess || null,
      action: "get",
      backend,
      failureClass: "missing_subject",
    });
    return scopeRejectGet(sid, sess);
  }
  if (!sess) {
    onTelemetry?.({
      event: "runtime.harness.session_store",
      outcome: "rejected",
      subjectId: sid,
      sessionId: null,
      action: "get",
      backend,
      failureClass: "missing_session",
    });
    return scopeRejectGet(sid, sess);
  }
  if (options?.syncInFlight === true) {
    onTelemetry?.({
      event: "runtime.harness.session_store",
      outcome: "rejected",
      subjectId: sid,
      sessionId: sess,
      action: "get",
      backend,
      failureClass: "sync_in_flight",
    });
    return {
      ok: false,
      failureClass: "sync_in_flight",
      subjectId: sid,
      sessionId: sess,
      detail: "rehydrate deferred until sync completes (CRDT merge)",
    };
  }

  if (raw === undefined) {
    onTelemetry?.({
      event: "runtime.harness.session_store",
      outcome: "advisory",
      subjectId: sid,
      sessionId: sess,
      action: "get",
      backend,
      status: "not_found",
      advisory: SESSION_ADVISORY_CLEAN_SESSION,
    });
    return {
      ok: true,
      status: "not_found",
      subjectId: sid,
      sessionId: sess,
      advisory: SESSION_ADVISORY_CLEAN_SESSION,
    };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    onTelemetry?.({
      event: "runtime.harness.session_store",
      outcome: "advisory",
      subjectId: sid,
      sessionId: sess,
      action: "get",
      backend,
      advisory: SESSION_ADVISORY_CLEAN_SESSION,
      failureClass: "corrupted",
    });
    return {
      ok: true,
      status: "corrupted_advisory",
      subjectId: sid,
      sessionId: sess,
      advisory: SESSION_ADVISORY_CLEAN_SESSION,
      failureClass: "corrupted",
      detail: "durable blob is not valid JSON",
    };
  }

  const validated = parseSessionDurableState(parsedJson);
  if (!validated.ok) {
    const fc =
      validated.failureClass === "version_mismatch"
        ? "version_mismatch"
        : validated.failureClass === "corrupted"
          ? "corrupted"
          : "corrupted";
    onTelemetry?.({
      event: "runtime.harness.session_store",
      outcome: "advisory",
      subjectId: sid,
      sessionId: sess,
      action: "validate",
      backend,
      advisory: SESSION_ADVISORY_CLEAN_SESSION,
      failureClass: fc,
    });
    return {
      ok: true,
      status: "corrupted_advisory",
      subjectId: sid,
      sessionId: sess,
      advisory: SESSION_ADVISORY_CLEAN_SESSION,
      failureClass: fc === "version_mismatch" ? "version_mismatch" : "corrupted",
      detail: validated.detail,
    };
  }

  if (validated.state.subjectId !== sid) {
    onTelemetry?.({
      event: "runtime.harness.session_store",
      outcome: "rejected",
      subjectId: sid,
      sessionId: sess,
      action: "get",
      backend,
      failureClass: "cross_subject",
    });
    return {
      ok: false,
      failureClass: "cross_subject",
      subjectId: sid,
      sessionId: sess,
      detail: "stored subjectId does not match request",
    };
  }
  if (validated.state.sessionId !== sess) {
    return {
      ok: false,
      failureClass: "invalid_state",
      subjectId: sid,
      sessionId: sess,
      detail: "stored sessionId does not match request",
    };
  }

  if (isEmptyDurable(validated.state)) {
    onTelemetry?.({
      event: "runtime.harness.session_store",
      outcome: "ok",
      subjectId: sid,
      sessionId: sess,
      action: "get",
      backend,
      status: "empty",
      stateVector: validated.state.stateVector,
      advisory: SESSION_ADVISORY_CLEAN_SESSION,
      correctionCount: 0,
      hasPlan: false,
      hasSummary: false,
    });
    return {
      ok: true,
      status: "empty",
      state: validated.state,
      subjectId: sid,
      sessionId: sess,
      advisory: SESSION_ADVISORY_CLEAN_SESSION,
    };
  }

  onTelemetry?.({
    event: "runtime.harness.session_store",
    outcome: "ok",
    subjectId: sid,
    sessionId: sess,
    ...(validated.state.deviceId !== undefined
      ? { deviceId: validated.state.deviceId }
      : {}),
    action: "get",
    backend,
    status: "found",
    stateVector: validated.state.stateVector,
    correctionCount: validated.state.correctionRefs.length,
    hasPlan: validated.state.activePlan !== null,
    hasSummary: validated.state.compactionSummary !== null,
  });

  return {
    ok: true,
    status: "found",
    state: validated.state,
    subjectId: sid,
    sessionId: sess,
    ...(validated.state.deviceId !== undefined
      ? { deviceId: validated.state.deviceId }
      : {}),
  };
}

type Kv = {
  read: (key: string) => string | undefined;
  write: (
    key: string,
    value: string,
  ) => { ok: true } | { ok: false; detail: string };
};

function putSerialized(
  state: SessionDurableState,
  options: SessionStoreOpOptions | undefined,
  kv: Kv,
  onTelemetry: ((e: SessionDurableTelemetryEvent) => void) | undefined,
  backend: SessionDurableBackendName,
): SessionStorePutResult {
  if (options?.syncInFlight === true) {
    const sid = trimStr(state?.subjectId);
    const sess = trimStr(state?.sessionId);
    onTelemetry?.({
      event: "runtime.harness.session_store",
      outcome: "rejected",
      subjectId: sid || null,
      sessionId: sess || null,
      action: "put",
      backend,
      failureClass: "sync_in_flight",
    });
    return {
      ok: false,
      failureClass: "sync_in_flight",
      subjectId: sid || null,
      sessionId: sess || null,
      detail: "put deferred until sync completes (CRDT merge)",
    };
  }

  const validated = parseSessionDurableState(state);
  if (!validated.ok) {
    return {
      ok: false,
      failureClass: validated.failureClass,
      subjectId: trimStr(state?.subjectId) || null,
      sessionId: trimStr(state?.sessionId) || null,
      detail: validated.detail,
    };
  }
  const next = validated.state;
  const key = storeKey(next.subjectId, next.sessionId);

  const existingRaw = kv.read(key);
  if (existingRaw === undefined) {
    if (next.stateVector !== 0) {
      return {
        ok: false,
        failureClass: "invalid_state",
        subjectId: next.subjectId,
        sessionId: next.sessionId,
        detail: "first put requires stateVector 0",
      };
    }
  } else {
    let existingJson: unknown;
    let parseOk = false;
    try {
      existingJson = JSON.parse(existingRaw);
      parseOk = true;
    } catch {
      parseOk = false;
    }
    const existing = parseOk
      ? parseSessionDurableState(existingJson)
      : ({ ok: false as const });
    if (existing.ok) {
      if (existing.state.subjectId !== next.subjectId) {
        return {
          ok: false,
          failureClass: "cross_subject",
          subjectId: next.subjectId,
          sessionId: next.sessionId,
          detail: "cannot overwrite a different subjectId",
        };
      }
      if (
        options?.expectedStateVector !== undefined &&
        options.expectedStateVector !== existing.state.stateVector
      ) {
        onTelemetry?.({
          event: "runtime.harness.session_store",
          outcome: "rejected",
          subjectId: next.subjectId,
          sessionId: next.sessionId,
          action: "put",
          backend,
          failureClass: "stale_state_vector",
          stateVector: existing.state.stateVector,
        });
        return {
          ok: false,
          failureClass: "stale_state_vector",
          subjectId: next.subjectId,
          sessionId: next.sessionId,
          detail: `stale state vector: expected ${options.expectedStateVector}, store has ${existing.state.stateVector}`,
        };
      }
      // Idempotent: identical payload at same vector.
      if (
        next.stateVector === existing.state.stateVector &&
        canonicalizeSessionDurableStateJson(existing.state) ===
          canonicalizeSessionDurableStateJson(next)
      ) {
        onTelemetry?.({
          event: "runtime.harness.session_store",
          outcome: "ok",
          subjectId: next.subjectId,
          sessionId: next.sessionId,
          action: "put",
          backend,
          status: "idempotent",
          stateVector: next.stateVector,
          correctionCount: next.correctionRefs.length,
          hasPlan: next.activePlan !== null,
          hasSummary: next.compactionSummary !== null,
        });
        return {
          ok: true,
          subjectId: next.subjectId,
          sessionId: next.sessionId,
          ...(next.deviceId !== undefined ? { deviceId: next.deviceId } : {}),
          stateVector: next.stateVector,
          idempotent: true,
        };
      }
      // Advance: client must bump stateVector to existing+1.
      if (next.stateVector !== existing.state.stateVector + 1) {
        return {
          ok: false,
          failureClass: "stale_state_vector",
          subjectId: next.subjectId,
          sessionId: next.sessionId,
          detail: `next stateVector must be ${existing.state.stateVector + 1}`,
        };
      }
    } else if (
      options?.expectedStateVector !== undefined &&
      options.expectedStateVector !== 0
    ) {
      return {
        ok: false,
        failureClass: "stale_state_vector",
        subjectId: next.subjectId,
        sessionId: next.sessionId,
        detail: "corrupted entry recovery requires expectedStateVector 0",
      };
    }
  }

  const serialized = canonicalizeSessionDurableStateJson(next);
  const written = kv.write(key, serialized);
  if (!written.ok) {
    return {
      ok: false,
      failureClass: "backend_error",
      subjectId: next.subjectId,
      sessionId: next.sessionId,
      detail: written.detail,
    };
  }

  onTelemetry?.({
    event: "runtime.harness.session_store",
    outcome: "ok",
    subjectId: next.subjectId,
    sessionId: next.sessionId,
    ...(next.deviceId !== undefined ? { deviceId: next.deviceId } : {}),
    action: "put",
    backend,
    status: "written",
    stateVector: next.stateVector,
    correctionCount: next.correctionRefs.length,
    hasPlan: next.activePlan !== null,
    hasSummary: next.compactionSummary !== null,
  });

  return {
    ok: true,
    subjectId: next.subjectId,
    sessionId: next.sessionId,
    ...(next.deviceId !== undefined ? { deviceId: next.deviceId } : {}),
    stateVector: next.stateVector,
  };
}

function deleteSerialized(
  subjectId: string,
  sessionId: string,
  options: SessionStoreOpOptions | undefined,
  kv: {
    read: (key: string) => string | undefined;
    remove: (key: string) => boolean;
  },
  onTelemetry: ((e: SessionDurableTelemetryEvent) => void) | undefined,
  backend: SessionDurableBackendName,
): SessionStoreDeleteResult {
  const sid = trimStr(subjectId);
  const sess = trimStr(sessionId);
  if (!sid) {
    return {
      ok: false,
      failureClass: "missing_subject",
      subjectId: null,
      sessionId: sess || null,
      detail: "subjectId required",
    };
  }
  if (!sess) {
    return {
      ok: false,
      failureClass: "missing_session",
      subjectId: sid,
      sessionId: null,
      detail: "sessionId required",
    };
  }
  if (options?.syncInFlight === true) {
    return {
      ok: false,
      failureClass: "sync_in_flight",
      subjectId: sid,
      sessionId: sess,
      detail: "delete deferred until sync completes",
    };
  }
  const key = storeKey(sid, sess);
  const deleted = kv.read(key) !== undefined ? kv.remove(key) : false;
  onTelemetry?.({
    event: "runtime.harness.session_store",
    outcome: "ok",
    subjectId: sid,
    sessionId: sess,
    action: "delete",
    backend,
    status: "deleted",
  });
  return { ok: true, subjectId: sid, sessionId: sess, deleted };
}

/** Canonical JSON for durable blobs (sorted keys, 2-space, trailing newline). */
export function canonicalizeSessionDurableStateJson(
  state: SessionDurableState,
): string {
  return `${JSON.stringify(sortKeysDeep(state), null, 2)}\n`;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = sortKeysDeep(obj[key]);
    }
    return out;
  }
  return value;
}

function normalizeProfile(profile: SessionProfileSnapshot): SessionProfileSnapshot {
  return {
    domainId: trimStr(profile.domainId),
    charter: typeof profile.charter === "string" ? profile.charter : "",
    refusals: Array.isArray(profile.refusals)
      ? profile.refusals.filter((r) => typeof r === "string")
      : [],
    languages: Array.isArray(profile.languages)
      ? profile.languages.filter((l) => typeof l === "string")
      : [],
  };
}

function parseProfile(
  raw: unknown,
):
  | { ok: true; profile: SessionProfileSnapshot }
  | { ok: false; failureClass: "invalid_state" | "section_limit"; detail: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      failureClass: "invalid_state",
      detail: "profile must be an object",
    };
  }
  const p = raw as Record<string, unknown>;
  const domainId = trimStr(p.domainId);
  if (!domainId) {
    return {
      ok: false,
      failureClass: "invalid_state",
      detail: "profile.domainId required",
    };
  }
  if (typeof p.charter !== "string") {
    return {
      ok: false,
      failureClass: "invalid_state",
      detail: "profile.charter must be a string",
    };
  }
  if (p.charter.length > SESSION_DURABLE_SECTION_CHAR_LIMIT) {
    return {
      ok: false,
      failureClass: "section_limit",
      detail: "profile.charter exceeds section limit",
    };
  }
  if (!Array.isArray(p.refusals) || !Array.isArray(p.languages)) {
    return {
      ok: false,
      failureClass: "invalid_state",
      detail: "profile.refusals and languages must be arrays",
    };
  }
  if (p.refusals.length > SESSION_CORRECTION_REF_LIMIT) {
    return {
      ok: false,
      failureClass: "section_limit",
      detail: "profile.refusals exceed scan limit",
    };
  }
  return {
    ok: true,
    profile: {
      domainId,
      charter: p.charter,
      refusals: p.refusals.filter((r): r is string => typeof r === "string"),
      languages: p.languages.filter((l): l is string => typeof l === "string"),
    },
  };
}

function parsePlan(
  raw: unknown,
):
  | { ok: true; plan: Plan }
  | { ok: false; failureClass: "invalid_state"; detail: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      failureClass: "invalid_state",
      detail: "activePlan must be an object or null",
    };
  }
  const p = raw as Record<string, unknown>;
  if (typeof p.planId !== "string" || !p.planId.trim()) {
    return {
      ok: false,
      failureClass: "invalid_state",
      detail: "activePlan.planId required",
    };
  }
  if (typeof p.rationale !== "string") {
    return {
      ok: false,
      failureClass: "invalid_state",
      detail: "activePlan.rationale required",
    };
  }
  if (!Array.isArray(p.steps)) {
    return {
      ok: false,
      failureClass: "invalid_state",
      detail: "activePlan.steps must be an array",
    };
  }
  return {
    ok: true,
    plan: {
      planId: p.planId.trim(),
      rationale: p.rationale,
      steps: p.steps as Plan["steps"],
    },
  };
}

function parseCorrectionRefs(
  raw: unknown,
):
  | { ok: true; refs: SessionCorrectionRef[] }
  | {
      ok: false;
      failureClass: "invalid_state" | "section_limit";
      detail: string;
    } {
  if (raw === undefined || raw === null) {
    return { ok: true, refs: [] };
  }
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      failureClass: "invalid_state",
      detail: "correctionRefs must be an array",
    };
  }
  if (raw.length > SESSION_CORRECTION_REF_LIMIT) {
    return {
      ok: false,
      failureClass: "section_limit",
      detail: `correctionRefs exceed limit ${SESSION_CORRECTION_REF_LIMIT}`,
    };
  }
  const refs: SessionCorrectionRef[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (!item || typeof item !== "object") {
      return {
        ok: false,
        failureClass: "invalid_state",
        detail: `correctionRefs[${i}] invalid`,
      };
    }
    const r = item as Record<string, unknown>;
    const memoryId = trimStr(r.memoryId);
    if (!memoryId) {
      return {
        ok: false,
        failureClass: "invalid_state",
        detail: `correctionRefs[${i}].memoryId required`,
      };
    }
    if (r.kind !== "correction") {
      return {
        ok: false,
        failureClass: "invalid_state",
        detail: `correctionRefs[${i}].kind must be 'correction'`,
      };
    }
    if (typeof r.text !== "string" || r.text.length === 0) {
      return {
        ok: false,
        failureClass: "invalid_state",
        detail: `correctionRefs[${i}].text required`,
      };
    }
    if (r.text.length > SESSION_DURABLE_SECTION_CHAR_LIMIT) {
      return {
        ok: false,
        failureClass: "section_limit",
        detail: `correctionRefs[${i}].text exceeds section limit`,
      };
    }
    refs.push({ memoryId, kind: "correction", text: r.text });
  }
  return { ok: true, refs };
}

/**
 * Context + plan seed produced by durable-tier rehydration.
 * Hosts pass this into the turn path — never an N-turn history replay.
 */
export type RehydratedTurnSeed = {
  subjectId: string;
  sessionId: string;
  deviceId?: string;
  profile: SessionProfileSnapshot;
  activePlan: Plan | null;
  /** System messages only (compaction summary) — no historical user/assistant turns. */
  messages: ChatMessage[];
  /** Correction-kind memories always present; episodic omitted. */
  memories: ContextMemoryItem[];
  retrieval: [];
  pendingDynamicBlock: string;
  protectedTexts: string[];
  compactionSummary: string | null;
  summaryHash?: string;
  correctionCount: number;
  /** Always true — durable tier load never walks full history. */
  skippedHistoryReplay: true;
  stateVector: number;
};

export type RehydrateSessionAccepted = {
  ok: true;
  status: "rehydrated" | "clean_session";
  subjectId: string;
  sessionId: string;
  deviceId?: string;
  advisory?: SessionDurableAdvisoryCode;
  seed: RehydratedTurnSeed;
  durableStatus: "found" | "empty" | "not_found" | "corrupted_advisory";
  contextBudgetSnapshot?: ContextBudgetSnapshot;
  /** Present when durable blob carries updatedAtMs and nowMs was injected. */
  daysSinceWrite?: number;
  usedLlm: false;
};

export type RehydrateSessionRejected = {
  ok: false;
  failureClass: SessionDurableFailureClass;
  subjectId: string | null;
  sessionId: string | null;
  detail: string;
};

export type RehydrateSessionResult =
  | RehydrateSessionAccepted
  | RehydrateSessionRejected;

export type RehydrateSessionOptions = {
  syncInFlight?: boolean;
  /**
   * Current-turn utterance for the pending dynamic block.
   * Never treated as historical replay.
   */
  utterance?: string;
  /**
   * Injected wall clock (ms) for days-gap math against
   * {@link SessionDurableState.updatedAtMs}. Does not expire sessions.
   */
  nowMs?: number;
  onTelemetry?: (event: SessionDurableTelemetryEvent) => void;
};

/**
 * Whole UTC days between write clock and resume clock (floor, ≥ 0).
 * Returns null when either timestamp is missing/invalid.
 */
export function computeSessionDaysSinceWrite(
  updatedAtMs: number | undefined,
  nowMs: number | undefined,
): number | null {
  if (
    typeof updatedAtMs !== "number" ||
    typeof nowMs !== "number" ||
    !Number.isFinite(updatedAtMs) ||
    !Number.isFinite(nowMs) ||
    !Number.isInteger(updatedAtMs) ||
    !Number.isInteger(nowMs) ||
    updatedAtMs < 0 ||
    nowMs < 0
  ) {
    return null;
  }
  if (nowMs < updatedAtMs) return 0;
  return Math.floor((nowMs - updatedAtMs) / SESSION_DAY_MS);
}

/**
 * Resume a session from the durable tier: load profile / plan / compaction
 * summary / corrections, seed context budget + dynamic block, and skip full
 * history replay.
 *
 * Missing or corrupted durable state → clean_session advisory (not a crash).
 */
export function rehydrateSessionForTurn(input: {
  store: SessionDurableStore;
  subjectId: string;
  sessionId: string;
  budget?: ContextBudgetManager;
  options?: RehydrateSessionOptions;
}): RehydrateSessionResult {
  const onTelemetry = input.options?.onTelemetry;
  const subjectId = trimStr(input.subjectId);
  const sessionId = trimStr(input.sessionId);
  if (!subjectId) {
    onTelemetry?.({
      event: "runtime.harness.session_store",
      outcome: "rejected",
      subjectId: null,
      sessionId: sessionId || null,
      action: "rehydrate",
      failureClass: "missing_subject",
    });
    return {
      ok: false,
      failureClass: "missing_subject",
      subjectId: null,
      sessionId: sessionId || null,
      detail: "subjectId required",
    };
  }
  if (!sessionId) {
    onTelemetry?.({
      event: "runtime.harness.session_store",
      outcome: "rejected",
      subjectId,
      sessionId: null,
      action: "rehydrate",
      failureClass: "missing_session",
    });
    return {
      ok: false,
      failureClass: "missing_session",
      subjectId,
      sessionId: null,
      detail: "sessionId required",
    };
  }

  if (
    input.budget !== undefined &&
    !(input.budget instanceof ContextBudgetManager)
  ) {
    return {
      ok: false,
      failureClass: "invalid_state",
      subjectId,
      sessionId,
      detail: "budget must be a ContextBudgetManager when provided",
    };
  }

  if (
    input.budget !== undefined &&
    input.budget.subjectId !== subjectId
  ) {
    onTelemetry?.({
      event: "runtime.harness.session_store",
      outcome: "rejected",
      subjectId,
      sessionId,
      action: "rehydrate",
      failureClass: "cross_subject",
    });
    return {
      ok: false,
      failureClass: "cross_subject",
      subjectId,
      sessionId,
      detail: "ContextBudgetManager subjectId does not match request",
    };
  }

  const loaded = input.store.get(subjectId, sessionId, {
    ...(input.options?.syncInFlight !== undefined
      ? { syncInFlight: input.options.syncInFlight }
      : {}),
  });

  if (!loaded.ok) {
    onTelemetry?.({
      event: "runtime.harness.session_store",
      outcome: "rejected",
      subjectId: loaded.subjectId,
      sessionId: loaded.sessionId,
      action: "rehydrate",
      failureClass: loaded.failureClass,
    });
    return {
      ok: false,
      failureClass: loaded.failureClass,
      subjectId: loaded.subjectId,
      sessionId: loaded.sessionId,
      detail: loaded.detail,
    };
  }

  const utterance =
    typeof input.options?.utterance === "string"
      ? input.options.utterance
      : "";
  if (utterance.length > SESSION_DURABLE_SECTION_CHAR_LIMIT) {
    return {
      ok: false,
      failureClass: "section_limit",
      subjectId,
      sessionId,
      detail: `utterance exceeds ${SESSION_DURABLE_SECTION_CHAR_LIMIT}`,
    };
  }

  if (
    loaded.status === "not_found" ||
    loaded.status === "corrupted_advisory"
  ) {
    const seed = buildCleanSeed({
      subjectId,
      sessionId,
      utterance,
      ...(input.budget?.deviceId !== undefined
        ? { deviceId: input.budget.deviceId }
        : {}),
    });
    let snapshot: ContextBudgetSnapshot | undefined;
    if (input.budget) {
      const measured = input.budget.measure({
        messages: seed.messages,
        memories: seed.memories,
        retrieval: seed.retrieval,
        pendingDynamicBlock: seed.pendingDynamicBlock,
        protectedTexts: seed.protectedTexts,
      });
      if (measured.ok) snapshot = measured.snapshot;
    }
    onTelemetry?.({
      event: "runtime.harness.session_store",
      outcome: "advisory",
      subjectId,
      sessionId,
      action: "rehydrate",
      ...(loaded.status === "not_found" ? { status: "not_found" as const } : {}),
      advisory: SESSION_ADVISORY_CLEAN_SESSION,
      ...(loaded.status === "corrupted_advisory"
        ? { failureClass: loaded.failureClass }
        : {}),
      correctionCount: 0,
      hasPlan: false,
      hasSummary: false,
    });
    return {
      ok: true,
      status: "clean_session",
      subjectId,
      sessionId,
      ...(seed.deviceId !== undefined ? { deviceId: seed.deviceId } : {}),
      advisory: SESSION_ADVISORY_CLEAN_SESSION,
      seed,
      durableStatus: loaded.status,
      ...(snapshot !== undefined ? { contextBudgetSnapshot: snapshot } : {}),
      usedLlm: false,
    };
  }

  // found | empty — both carry a validated state
  const state = loaded.state;
  if (state.subjectId !== subjectId) {
    return {
      ok: false,
      failureClass: "cross_subject",
      subjectId,
      sessionId,
      detail: "durable subjectId does not match request",
    };
  }

  const seed = buildSeedFromDurable(state, utterance);
  let snapshot: ContextBudgetSnapshot | undefined;
  if (input.budget) {
    const measured = input.budget.measure({
      messages: seed.messages,
      memories: seed.memories,
      retrieval: seed.retrieval,
      pendingDynamicBlock: seed.pendingDynamicBlock,
      protectedTexts: seed.protectedTexts,
    });
    if (measured.ok) snapshot = measured.snapshot;
  }

  const status =
    loaded.status === "empty" ? "clean_session" : "rehydrated";

  const daysSinceWrite = computeSessionDaysSinceWrite(
    state.updatedAtMs,
    input.options?.nowMs,
  );

  onTelemetry?.({
    event: "runtime.harness.session_store",
    outcome: status === "clean_session" ? "advisory" : "ok",
    subjectId,
    sessionId,
    ...(state.deviceId !== undefined ? { deviceId: state.deviceId } : {}),
    action: "rehydrate",
    status: loaded.status,
    ...(status === "clean_session"
      ? { advisory: SESSION_ADVISORY_CLEAN_SESSION }
      : {}),
    stateVector: state.stateVector,
    correctionCount: seed.correctionCount,
    hasPlan: seed.activePlan !== null,
    hasSummary: seed.compactionSummary !== null,
    ...(daysSinceWrite !== null ? { daysSinceWrite } : {}),
    ...(state.updatedAtMs !== undefined
      ? { updatedAtMs: state.updatedAtMs }
      : {}),
  });

  return {
    ok: true,
    status,
    subjectId,
    sessionId,
    ...(state.deviceId !== undefined ? { deviceId: state.deviceId } : {}),
    ...(status === "clean_session"
      ? { advisory: SESSION_ADVISORY_CLEAN_SESSION }
      : {}),
    seed,
    durableStatus: loaded.status,
    ...(snapshot !== undefined ? { contextBudgetSnapshot: snapshot } : {}),
    ...(daysSinceWrite !== null ? { daysSinceWrite } : {}),
    usedLlm: false,
  };
}

function buildCleanSeed(input: {
  subjectId: string;
  sessionId: string;
  utterance: string;
  deviceId?: string;
}): RehydratedTurnSeed {
  return {
    subjectId: input.subjectId,
    sessionId: input.sessionId,
    ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
    profile: {
      domainId: "",
      charter: "",
      refusals: [],
      languages: [],
    },
    activePlan: null,
    messages: [],
    memories: [],
    retrieval: [],
    pendingDynamicBlock: input.utterance,
    protectedTexts: [],
    compactionSummary: null,
    correctionCount: 0,
    skippedHistoryReplay: true,
    stateVector: 0,
  };
}

function buildSeedFromDurable(
  state: SessionDurableState,
  utterance: string,
): RehydratedTurnSeed {
  const messages: ChatMessage[] = [];
  if (
    typeof state.compactionSummary === "string" &&
    state.compactionSummary.length > 0
  ) {
    messages.push({ role: "system", content: state.compactionSummary });
  }

  const memories: ContextMemoryItem[] = state.correctionRefs.map((ref) => ({
    id: ref.memoryId,
    kind: "correction",
    text: ref.text,
    score: 1,
  }));

  const protectedTexts = [
    ...state.profile.refusals,
    ...(state.activePlan
      ? state.activePlan.steps
          .filter((s) => s.status === "active" || s.status === "pending")
          .map((s) => s.action)
          .filter((a) => typeof a === "string" && a.length > 0)
      : []),
  ];

  return {
    subjectId: state.subjectId,
    sessionId: state.sessionId,
    ...(state.deviceId !== undefined ? { deviceId: state.deviceId } : {}),
    profile: state.profile,
    activePlan: state.activePlan,
    messages,
    memories,
    retrieval: [],
    pendingDynamicBlock: utterance,
    protectedTexts,
    compactionSummary: state.compactionSummary,
    ...(state.summaryHash !== undefined
      ? { summaryHash: state.summaryHash }
      : {}),
    correctionCount: memories.length,
    skippedHistoryReplay: true,
    stateVector: state.stateVector,
  };
}

/**
 * Integration scenario: commit durable state at `writeAtMs`, resume at
 * `resumeAtMs` (days gap via clock inject), rehydrate without N-turn replay.
 *
 * Asserts correction texts survive and history messages stay empty.
 */
export function runSessionRehydrationDaysGapScenario(input: {
  store: SessionDurableStore;
  state: SessionDurableState;
  writeAtMs: number;
  resumeAtMs: number;
  utterance: string;
  budget?: ContextBudgetManager;
  onTelemetry?: (event: SessionDurableTelemetryEvent) => void;
}):
  | {
      ok: true;
      daysSinceWrite: number;
      rehydrate: RehydrateSessionAccepted;
      correctionsIntact: boolean;
      skippedHistoryReplay: true;
      historyMessageCount: number;
      putIdempotentReplay: boolean;
    }
  | {
      ok: false;
      failureClass: SessionDurableFailureClass;
      detail: string;
      subjectId: string | null;
      sessionId: string | null;
    } {
  if (
    !Number.isInteger(input.writeAtMs) ||
    !Number.isInteger(input.resumeAtMs) ||
    input.writeAtMs < 0 ||
    input.resumeAtMs < 0
  ) {
    return {
      ok: false,
      failureClass: "invalid_state",
      detail: "writeAtMs and resumeAtMs must be non-negative integers",
      subjectId: trimStr(input.state?.subjectId) || null,
      sessionId: trimStr(input.state?.sessionId) || null,
    };
  }

  const state: SessionDurableState = {
    ...input.state,
    updatedAtMs: input.writeAtMs,
  };
  const put = input.store.put(state);
  if (!put.ok) {
    return {
      ok: false,
      failureClass: put.failureClass,
      detail: put.detail,
      subjectId: put.subjectId,
      sessionId: put.sessionId,
    };
  }

  // Idempotent replay of the same commit (duplicate request).
  const putAgain = input.store.put(state, {
    expectedStateVector: state.stateVector,
  });
  const putIdempotentReplay = putAgain.ok === true && putAgain.idempotent === true;

  const rehydrate = rehydrateSessionForTurn({
    store: input.store,
    subjectId: state.subjectId,
    sessionId: state.sessionId,
    ...(input.budget !== undefined ? { budget: input.budget } : {}),
    options: {
      utterance: input.utterance,
      nowMs: input.resumeAtMs,
      ...(input.onTelemetry !== undefined
        ? { onTelemetry: input.onTelemetry }
        : {}),
    },
  });
  if (!rehydrate.ok) {
    return {
      ok: false,
      failureClass: rehydrate.failureClass,
      detail: rehydrate.detail,
      subjectId: rehydrate.subjectId,
      sessionId: rehydrate.sessionId,
    };
  }

  const expectedCorrections = state.correctionRefs.map((c) => c.text).sort();
  const actualCorrections = rehydrate.seed.memories
    .filter((m) => m.kind === "correction")
    .map((m) => m.text)
    .sort();
  const correctionsIntact =
    expectedCorrections.length === actualCorrections.length &&
    expectedCorrections.every((t, i) => t === actualCorrections[i]);

  const historyMessageCount = rehydrate.seed.messages.filter(
    (m) => m.role === "user" || m.role === "assistant",
  ).length;

  const daysSinceWrite =
    rehydrate.daysSinceWrite ??
    computeSessionDaysSinceWrite(input.writeAtMs, input.resumeAtMs) ??
    0;

  return {
    ok: true,
    daysSinceWrite,
    rehydrate,
    correctionsIntact,
    skippedHistoryReplay: true,
    historyMessageCount,
    putIdempotentReplay,
  };
}

function trimStr(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safePathSegment(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32);
}
