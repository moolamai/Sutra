/**
 * Wire-shape obligations — Track A → Track B merge point (M-G1).
 *
 * Frozen JSON Schema export is loaded at harness **build time** into
 * `fixtures/wire/bundle.json` (see `scripts/generate-wire-fixtures.mjs`).
 * Fixtures are derived from schemas/ + committed golden envelopes — never
 * hand-written CognitiveState shapes.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import * as addFormatsNS from "ajv-formats";

import {
  ObligationRegistry,
  ObligationViolation,
  defineObligation,
  type Obligation,
  type ObligationContext,
} from "../registry.js";

type AddFormatsFn = (ajv: Ajv, options?: object) => Ajv;
const addFormats = (addFormatsNS as unknown as { default: AddFormatsFn }).default;

const MUST_SYNC_REQUEST =
  "Every implementation-produced SyncRequest MUST validate against the frozen SyncRequest JSON Schema (SYNC-01).";

const MUST_SUBJECT_SCOPE =
  "SyncRequest.edgeState.subjectId MUST equal the obligation subject scope (subject isolation).";

export interface WireFixtureViolation {
  field: string;
  kind: string;
  payload: unknown;
}

export interface WireFixtureBundle {
  note: string;
  generatedFrom: { schema: string; golden: string };
  schemaTitle: string;
  schemaProtocolVersion: string;
  topLevelRequired: string[];
  schema: object;
  valid: Record<string, unknown>;
  violations: WireFixtureViolation[];
}

/** Minimal producer surface under test for wire-shape obligations. */
export interface SyncRequestProducer {
  produceSyncRequest(ctx: ObligationContext): Promise<unknown> | unknown;
}

function packageRoot(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** Path to the build-time generated wire fixture bundle. */
export function wireFixtureBundlePath(): string {
  return path.join(packageRoot(), "fixtures", "wire", "bundle.json");
}

/** Load the generated bundle (embeds the frozen SyncRequest schema). */
export function loadWireFixtureBundle(
  bundlePath: string = wireFixtureBundlePath(),
): WireFixtureBundle {
  const raw = JSON.parse(readFileSync(bundlePath, "utf8")) as WireFixtureBundle;
  if (raw.schemaTitle !== "SyncRequest") {
    throw new Error(
      `wire fixture bundle schemaTitle must be SyncRequest, got ${raw.schemaTitle}`,
    );
  }
  if (!Array.isArray(raw.topLevelRequired) || raw.topLevelRequired.length === 0) {
    throw new Error("wire fixture bundle missing topLevelRequired");
  }
  if (raw.violations.length !== raw.topLevelRequired.length) {
    throw new Error(
      "wire fixture bundle must include one violation per top-level required field",
    );
  }
  return raw;
}

export function createSyncRequestValidator(
  schema: object,
): ValidateFunction {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    validateFormats: true,
  });
  addFormats(ajv);
  return ajv.compile(schema);
}

export function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return "unknown schema violation";
  return errors
    .map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`)
    .join("; ");
}

/**
 * Subject-scoped valid SyncRequest: rewrite edgeState.subjectId to ctx
 * so isolation checks and schema validation both apply.
 */
export function scopedValidSyncRequest(
  bundle: WireFixtureBundle,
  subjectId: string,
): Record<string, unknown> {
  const payload = structuredClone(bundle.valid) as Record<string, unknown>;
  const edge = structuredClone(payload.edgeState) as Record<string, unknown>;
  edge.subjectId = subjectId;
  payload.edgeState = edge;
  return payload;
}

export const WIRE_OBLIGATION_IDS = {
  syncRequestValidates: "SYNC-01.1",
  subjectIsolation: "SYNC-01.2",
} as const;

export function defineSyncRequestValidatesObligation(
  validate: ValidateFunction,
): Obligation<SyncRequestProducer> {
  return defineObligation({
    id: WIRE_OBLIGATION_IDS.syncRequestValidates,
    contract: "SyncRequest",
    mustText: MUST_SYNC_REQUEST,
    specIds: ["SYNC-01", "CK-01"],
    async check(impl, ctx) {
      const payload = await impl.produceSyncRequest(ctx);
      const ok = validate(payload);
      if (!ok) {
        throw new ObligationViolation({
          obligationId: WIRE_OBLIGATION_IDS.syncRequestValidates,
          mustText: MUST_SYNC_REQUEST,
          contract: "SyncRequest",
          message: formatAjvErrors(validate.errors),
        });
      }
    },
  });
}

export function defineSyncRequestSubjectIsolationObligation(): Obligation<SyncRequestProducer> {
  return defineObligation({
    id: WIRE_OBLIGATION_IDS.subjectIsolation,
    contract: "SyncRequest",
    mustText: MUST_SUBJECT_SCOPE,
    specIds: ["SYNC-01", "CK-01"],
    async check(impl, ctx) {
      const payload = (await impl.produceSyncRequest(ctx)) as {
        edgeState?: { subjectId?: string };
      };
      const produced = payload?.edgeState?.subjectId;
      if (produced !== ctx.subjectId) {
        throw new ObligationViolation({
          obligationId: WIRE_OBLIGATION_IDS.subjectIsolation,
          mustText: MUST_SUBJECT_SCOPE,
          contract: "SyncRequest",
          message: `edgeState.subjectId '${String(produced)}' !== scoped '${ctx.subjectId}'`,
        });
      }
    },
  });
}

/** Register wire-shape obligations against a registry. */
export function registerWireShapeObligations(
  registry: ObligationRegistry,
  bundle: WireFixtureBundle = loadWireFixtureBundle(),
): ObligationRegistry {
  const validate = createSyncRequestValidator(bundle.schema);
  registry.register(defineSyncRequestValidatesObligation(validate));
  registry.register(defineSyncRequestSubjectIsolationObligation());
  return registry;
}

/** Fresh registry with only wire-shape obligations. */
export function createWireShapeRegistry(
  bundle?: WireFixtureBundle,
): ObligationRegistry {
  return registerWireShapeObligations(new ObligationRegistry(), bundle);
}

/** Producer that returns a subject-scoped valid SyncRequest from the bundle. */
export function validSyncRequestProducer(
  bundle: WireFixtureBundle = loadWireFixtureBundle(),
): SyncRequestProducer {
  return {
    produceSyncRequest(ctx) {
      return scopedValidSyncRequest(bundle, ctx.subjectId);
    },
  };
}

/** Producer that returns a schema-invalid fixture (for seeded fail tests). */
export function violationSyncRequestProducer(
  violation: WireFixtureViolation,
): SyncRequestProducer {
  return {
    produceSyncRequest() {
      return structuredClone(violation.payload);
    },
  };
}
