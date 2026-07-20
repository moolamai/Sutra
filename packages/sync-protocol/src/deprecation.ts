/**
 * Deprecation advisory emission — never silent removal of wire fields.
 *
 * Deprecated paths emit SyncAdvisory `DEPRECATED_FIELD_PRESENT` with an
 * explicit sunset date in `detail`. The seeded test-only field proves the
 * parse path without changing the production CognitiveState schema shape.
 */

import {
  cognitiveStateSchema,
  syncAdvisorySchema,
  type CognitiveState,
  type SyncAdvisory,
} from "./contract.js";

/** Wire path of the seeded test-only deprecated field (not a production schema key). */
export const TEST_ONLY_DEPRECATED_FIELD_PATH =
  "profile.__deprTestLegacyLocale" as const;

/** Sunset date for the seeded test-only field (ISO calendar day). */
export const TEST_ONLY_DEPRECATED_SUNSET = "2027-01-13" as const;

export type DeprecatedFieldEntry = {
  /** Dot-path from document root (e.g. `profile.__deprTestLegacyLocale`). */
  path: string;
  /** Earliest calendar day removal is eligible (ISO `YYYY-MM-DD`). */
  sunsetDate: string;
  /** True when the field exists only to prove advisory emission. */
  testOnly: boolean;
  /** Optional human label — never learner content. */
  replacement?: string;
};

/**
 * Published deprecation registry. Append-only once announced.
 * Production deprecations land here after additive schema announcement.
 */
export const DEPRECATED_FIELD_REGISTRY: readonly DeprecatedFieldEntry[] =
  Object.freeze([
    {
      path: TEST_ONLY_DEPRECATED_FIELD_PATH,
      sunsetDate: TEST_ONLY_DEPRECATED_SUNSET,
      testOnly: true,
      replacement: "profile.language",
    },
  ]);

export type DeprecationParseEmit = {
  event: "protocol.deprecation";
  subjectId: string;
  deviceId?: string;
  field: string;
  sunsetDate: string;
  outcome: "advisory_emitted" | "absent" | "replay_idempotent";
};

export type ParseWithDeprecationOptions = {
  subjectId: string;
  deviceId?: string;
  /** Override registry (tests); default is {@link DEPRECATED_FIELD_REGISTRY}. */
  registry?: readonly DeprecatedFieldEntry[];
  emit?: (event: DeprecationParseEmit) => void;
};

function readPath(root: unknown, path: string): unknown {
  if (root === null || typeof root !== "object") return undefined;
  let cur: unknown = root;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * Format SyncAdvisory.detail for DEPRECATED_FIELD_PRESENT.
 * Machine-greppable; never includes field values (may be learner-adjacent).
 */
export function formatDeprecationAdvisoryDetail(
  entry: DeprecatedFieldEntry,
): string {
  const parts = [
    `field=${entry.path}`,
    `sunset=${entry.sunsetDate}`,
    `testOnly=${entry.testOnly ? "true" : "false"}`,
  ];
  if (entry.replacement) parts.push(`replacement=${entry.replacement}`);
  return parts.join(";");
}

/**
 * Scan a raw wire document for registered deprecated fields and emit advisories.
 * Presence of the key (even empty string) counts; `undefined` / missing does not.
 * Replay: same input → same advisory set (idempotent).
 */
export function collectDeprecationAdvisories(
  raw: unknown,
  opts: ParseWithDeprecationOptions,
): SyncAdvisory[] {
  const subjectId = opts.subjectId.trim();
  if (!subjectId) {
    throw new Error("subjectId is required (subject isolation)");
  }
  const registry = opts.registry ?? DEPRECATED_FIELD_REGISTRY;
  if (registry.length > 64) {
    throw new Error("deprecation registry exceeds bounded size (64)");
  }

  /** @type {SyncAdvisory[]} */
  const advisories: SyncAdvisory[] = [];
  for (const entry of registry) {
    const value = readPath(raw, entry.path);
    if (value === undefined) {
      opts.emit?.({
        event: "protocol.deprecation",
        subjectId,
        ...(opts.deviceId !== undefined ? { deviceId: opts.deviceId } : {}),
        field: entry.path,
        sunsetDate: entry.sunsetDate,
        outcome: "absent",
      });
      continue;
    }
    const advisory: SyncAdvisory = {
      code: "DEPRECATED_FIELD_PRESENT",
      detail: formatDeprecationAdvisoryDetail(entry),
    };
    // Validate against the closed wire schema so bad codes cannot leak.
    syncAdvisorySchema.parse(advisory);
    advisories.push(advisory);
    opts.emit?.({
      event: "protocol.deprecation",
      subjectId,
      ...(opts.deviceId !== undefined ? { deviceId: opts.deviceId } : {}),
      field: entry.path,
      sunsetDate: entry.sunsetDate,
      outcome: "advisory_emitted",
    });
  }
  return advisories;
}

export type CognitiveStateDeprecationParseResult = {
  state: CognitiveState;
  advisories: SyncAdvisory[];
};

/**
 * Parse CognitiveState and attach deprecation advisories from the raw payload.
 * Schema validation still strips unknown keys; advisories are collected first.
 */
export function parseCognitiveStateWithDeprecationAdvisories(
  raw: unknown,
  opts: ParseWithDeprecationOptions,
): CognitiveStateDeprecationParseResult {
  const advisories = collectDeprecationAdvisories(raw, opts);
  const state = cognitiveStateSchema.parse(raw);
  if (state.subjectId !== opts.subjectId.trim()) {
    throw new Error(
      `subjectId mismatch: payload '${state.subjectId}' !== scope '${opts.subjectId.trim()}'`,
    );
  }
  return { state, advisories };
}
