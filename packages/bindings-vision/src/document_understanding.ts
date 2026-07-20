/**
 * Document-understanding responseSchema profiles: CBSE worksheet, textbook
 * page, and prescription sketch. Schemas are versioned JSON files under
 * packages/bindings-vision/schemas/ — never inline strings in domain code.
 *
 * Extraction failures surface field-level confidence / partial + unresolvedFields;
 * the schema allows null for illegible values so callers never invent grades,
 * medications, doses, frequencies, or diagnoses.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type {
  VisionInterface,
  VisualAnalysisResult,
  VisualInput,
} from "@moolam/contracts";
import { VISION_PACKAGE_ROOT, loadLocalVlm } from "./vlm_binding.js";

/** Bound array / key scans (scalability). */
export const DOCUMENT_SCHEMA_SCAN_LIMIT = 64;

export const DOCUMENT_SCHEMAS_DIR = path.join(VISION_PACKAGE_ROOT, "schemas");

export const DOCUMENT_FIXTURES_DIR = path.join(
  VISION_PACKAGE_ROOT,
  "fixtures",
  "document",
);

export const DEFAULT_DOCUMENT_FIXTURE_CATALOG = path.join(
  DOCUMENT_FIXTURES_DIR,
  "catalog.json",
);

export const CBSE_WORKSHEET_SCHEMA_ID = "cbse-worksheet";
export const TEXTBOOK_PAGE_SCHEMA_ID = "textbook-page";
export const PRESCRIPTION_SKETCH_SCHEMA_ID = "prescription-sketch";

export const CBSE_WORKSHEET_SCHEMA_VERSION =
  "bindings-vision.cbse-worksheet.v1" as const;
export const TEXTBOOK_PAGE_SCHEMA_VERSION =
  "bindings-vision.textbook-page.v1" as const;
export const PRESCRIPTION_SKETCH_SCHEMA_VERSION =
  "bindings-vision.prescription-sketch.v1" as const;

export const CBSE_WORKSHEET_SCHEMA_PATH = path.join(
  DOCUMENT_SCHEMAS_DIR,
  "cbse-worksheet.v1.json",
);

export const TEXTBOOK_PAGE_SCHEMA_PATH = path.join(
  DOCUMENT_SCHEMAS_DIR,
  "textbook-page.v1.json",
);

export const PRESCRIPTION_SKETCH_SCHEMA_PATH = path.join(
  DOCUMENT_SCHEMAS_DIR,
  "prescription-sketch.v1.json",
);

export type DocumentExtractionProfileId =
  | typeof CBSE_WORKSHEET_SCHEMA_ID
  | typeof TEXTBOOK_PAGE_SCHEMA_ID
  | typeof PRESCRIPTION_SKETCH_SCHEMA_ID
  | string;

export type DocumentSchemaMeta = {
  profileId: DocumentExtractionProfileId;
  schemaVersion: string;
  schemaPath: string;
  documentKind: string;
  /** Single-page only in v1 — multi-image batches rejected. */
  singlePageOnly: true;
  maxItems: number;
};

export type DocumentFixtureMeta = {
  id: string;
  profileId: DocumentExtractionProfileId;
  schemaRelpath: string;
  imageRelpath: string;
  answerRelpath: string;
  mimeType: string;
  byteLength: number;
  maxInputBytes: number;
  instruction: string;
};

export type DocumentFixtureCatalog = {
  schemaVersion: string;
  description?: string;
  fixtures: DocumentFixtureMeta[];
};

export type DocumentFixture = DocumentFixtureMeta & {
  schema: Record<string, unknown>;
  imageBytes: Uint8Array;
  imagePath: string;
  answerText: string;
  answerPath: string;
};

export type DocumentValidationOk = {
  ok: true;
  value: Record<string, unknown>;
  profileId: DocumentExtractionProfileId;
  schemaVersion: string;
};

export type DocumentValidationFail = {
  ok: false;
  message: string;
  failureClass: "schema" | "validation" | "config" | "batch";
  path?: string;
};

export type DocumentTelemetryEvent = {
  event: "bindings_vision.document_understanding";
  op: "load_schema" | "validate" | "reject_batch" | "extract";
  outcome: "ok" | "error";
  subjectId: string;
  deviceId: string;
  profileId?: string;
  schemaVersion?: string;
  failureClass?: DocumentValidationFail["failureClass"];
  detail?: string;
};

const PROFILE_REGISTRY: readonly DocumentSchemaMeta[] = [
  {
    profileId: CBSE_WORKSHEET_SCHEMA_ID,
    schemaVersion: CBSE_WORKSHEET_SCHEMA_VERSION,
    schemaPath: CBSE_WORKSHEET_SCHEMA_PATH,
    documentKind: "cbse-worksheet",
    singlePageOnly: true,
    maxItems: DOCUMENT_SCHEMA_SCAN_LIMIT,
  },
  {
    profileId: TEXTBOOK_PAGE_SCHEMA_ID,
    schemaVersion: TEXTBOOK_PAGE_SCHEMA_VERSION,
    schemaPath: TEXTBOOK_PAGE_SCHEMA_PATH,
    documentKind: "textbook-page",
    singlePageOnly: true,
    maxItems: DOCUMENT_SCHEMA_SCAN_LIMIT,
  },
  {
    profileId: PRESCRIPTION_SKETCH_SCHEMA_ID,
    schemaVersion: PRESCRIPTION_SKETCH_SCHEMA_VERSION,
    schemaPath: PRESCRIPTION_SKETCH_SCHEMA_PATH,
    documentKind: "prescription-sketch",
    singlePageOnly: true,
    maxItems: DOCUMENT_SCHEMA_SCAN_LIMIT,
  },
];

function emit(
  onTelemetry: ((e: DocumentTelemetryEvent) => void) | undefined,
  partial: Omit<DocumentTelemetryEvent, "event">,
): void {
  onTelemetry?.({
    event: "bindings_vision.document_understanding",
    ...partial,
  });
}

/**
 * Reject multi-image batches — v1 document path is single-page only unless a
 * future schema explicitly allows arrays of images (not these profiles).
 */
export function assertSingleDocumentImage(
  images: unknown,
  options: {
    subjectId: string;
    deviceId: string;
    onTelemetry?: (e: DocumentTelemetryEvent) => void;
  },
): DocumentValidationFail | { ok: true } {
  if (!Array.isArray(images)) {
    return { ok: true };
  }
  if (images.length <= 1) {
    return { ok: true };
  }
  const fail: DocumentValidationFail = {
    ok: false,
    message: `document path rejects multi-image batch (got ${images.length}; single page only)`,
    failureClass: "batch",
  };
  emit(options.onTelemetry, {
    op: "reject_batch",
    outcome: "error",
    subjectId: options.subjectId,
    deviceId: options.deviceId,
    failureClass: "batch",
    detail: fail.message,
  });
  return fail;
}

export function listDocumentExtractionProfiles(): DocumentSchemaMeta[] {
  return PROFILE_REGISTRY.map((p) => ({ ...p }));
}

export function resolveDocumentSchemaPath(
  profileId: DocumentExtractionProfileId,
): string {
  const row = PROFILE_REGISTRY.find((p) => p.profileId === profileId);
  if (!row) {
    throw new Error(`unknown document extraction profile: ${profileId}`);
  }
  return row.schemaPath;
}

export function loadDocumentResponseSchema(
  profileId: DocumentExtractionProfileId,
  options: {
    subjectId?: string;
    deviceId?: string;
    onTelemetry?: (e: DocumentTelemetryEvent) => void;
  } = {},
): Record<string, unknown> {
  const subjectId = options.subjectId?.trim() || "subj.document.schema";
  const deviceId = options.deviceId?.trim() || "dev-document";
  const meta = PROFILE_REGISTRY.find((p) => p.profileId === profileId);
  if (!meta) {
    emit(options.onTelemetry, {
      op: "load_schema",
      outcome: "error",
      subjectId,
      deviceId,
      profileId: String(profileId),
      failureClass: "config",
      detail: "unknown profile",
    });
    throw new Error(`unknown document extraction profile: ${profileId}`);
  }
  if (!existsSync(meta.schemaPath)) {
    emit(options.onTelemetry, {
      op: "load_schema",
      outcome: "error",
      subjectId,
      deviceId,
      profileId: meta.profileId,
      schemaVersion: meta.schemaVersion,
      failureClass: "config",
      detail: "schema file missing",
    });
    throw new Error(`document schema missing at ${meta.schemaPath}`);
  }
  const raw = JSON.parse(readFileSync(meta.schemaPath, "utf8")) as Record<
    string,
    unknown
  >;
  if (raw.schemaVersion !== meta.schemaVersion) {
    emit(options.onTelemetry, {
      op: "load_schema",
      outcome: "error",
      subjectId,
      deviceId,
      profileId: meta.profileId,
      failureClass: "config",
      detail: "schemaVersion mismatch",
    });
    throw new Error(
      `schemaVersion mismatch for ${profileId}: expected ${meta.schemaVersion}`,
    );
  }
  emit(options.onTelemetry, {
    op: "load_schema",
    outcome: "ok",
    subjectId,
    deviceId,
    profileId: meta.profileId,
    schemaVersion: meta.schemaVersion,
  });
  return raw;
}

function typeAllows(
  expected: unknown,
  value: unknown,
): boolean {
  const types = Array.isArray(expected) ? expected : [expected];
  for (const t of types) {
    if (t === "null" && value === null) return true;
    if (t === "string" && typeof value === "string") return true;
    if (t === "number" && typeof value === "number" && Number.isFinite(value)) {
      return true;
    }
    if (t === "integer" && typeof value === "number" && Number.isInteger(value)) {
      return true;
    }
    if (t === "boolean" && typeof value === "boolean") return true;
    if (t === "object" && value !== null && typeof value === "object" && !Array.isArray(value)) {
      return true;
    }
    if (t === "array" && Array.isArray(value)) return true;
  }
  return false;
}

function validateAgainstSchemaNode(
  value: unknown,
  schema: Record<string, unknown>,
  pathLabel: string,
): DocumentValidationFail | null {
  if ("const" in schema && value !== schema.const) {
    return {
      ok: false,
      message: `${pathLabel}: expected const ${JSON.stringify(schema.const)}`,
      failureClass: "schema",
      path: pathLabel,
    };
  }
  if ("enum" in schema && Array.isArray(schema.enum)) {
    if (!schema.enum.includes(value as never)) {
      return {
        ok: false,
        message: `${pathLabel}: value not in enum`,
        failureClass: "schema",
        path: pathLabel,
      };
    }
  }
  if ("type" in schema && !typeAllows(schema.type, value)) {
    return {
      ok: false,
      message: `${pathLabel}: type mismatch`,
      failureClass: "schema",
      path: pathLabel,
    };
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      return {
        ok: false,
        message: `${pathLabel}: below minimum`,
        failureClass: "schema",
        path: pathLabel,
      };
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      return {
        ok: false,
        message: `${pathLabel}: above maximum`,
        failureClass: "schema",
        path: pathLabel,
      };
    }
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      return {
        ok: false,
        message: `${pathLabel}: string too short`,
        failureClass: "schema",
        path: pathLabel,
      };
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      return {
        ok: false,
        message: `${pathLabel}: string too long`,
        failureClass: "schema",
        path: pathLabel,
      };
    }
  }
  if (Array.isArray(value)) {
    if (
      typeof schema.maxItems === "number" &&
      value.length > schema.maxItems
    ) {
      return {
        ok: false,
        message: `${pathLabel}: array exceeds maxItems=${schema.maxItems}`,
        failureClass: "schema",
        path: pathLabel,
      };
    }
    if (
      value.length > DOCUMENT_SCHEMA_SCAN_LIMIT ||
      (typeof schema.maxItems === "number" &&
        schema.maxItems > DOCUMENT_SCHEMA_SCAN_LIMIT &&
        value.length > DOCUMENT_SCHEMA_SCAN_LIMIT)
    ) {
      return {
        ok: false,
        message: `${pathLabel}: array exceeds scan limit ${DOCUMENT_SCHEMA_SCAN_LIMIT}`,
        failureClass: "schema",
        path: pathLabel,
      };
    }
    const itemSchema =
      schema.items &&
      typeof schema.items === "object" &&
      !Array.isArray(schema.items)
        ? (schema.items as Record<string, unknown>)
        : null;
    if (itemSchema) {
      for (let i = 0; i < Math.min(value.length, DOCUMENT_SCHEMA_SCAN_LIMIT); i++) {
        const child = validateAgainstSchemaNode(
          value[i],
          itemSchema,
          `${pathLabel}[${i}]`,
        );
        if (child) return child;
      }
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const required = Array.isArray(schema.required)
      ? (schema.required as unknown[]).filter(
          (k): k is string => typeof k === "string" && k.length > 0,
        )
      : [];
    for (const key of required.slice(0, DOCUMENT_SCHEMA_SCAN_LIMIT)) {
      if (!(key in obj) || obj[key] === undefined) {
        return {
          ok: false,
          message: `${pathLabel}: missing required '${key}'`,
          failureClass: "schema",
          path: `${pathLabel}.${key}`,
        };
      }
    }
    const properties =
      schema.properties &&
      typeof schema.properties === "object" &&
      !Array.isArray(schema.properties)
        ? (schema.properties as Record<string, Record<string, unknown>>)
        : {};
    for (const key of Object.keys(obj).slice(0, DOCUMENT_SCHEMA_SCAN_LIMIT)) {
      if (!(key in properties)) {
        if (schema.additionalProperties === false) {
          return {
            ok: false,
            message: `${pathLabel}: unexpected property '${key}'`,
            failureClass: "schema",
            path: `${pathLabel}.${key}`,
          };
        }
        continue;
      }
      const child = validateAgainstSchemaNode(
        obj[key],
        properties[key]!,
        `${pathLabel}.${key}`,
      );
      if (child) return child;
    }
  }
  return null;
}

/**
 * Validate a VisionInterface analyze() answer against a committed document
 * extraction schema. Nullables are allowed; invented required values fail.
 */
export function validateDocumentExtractionAnswer(
  answer: string,
  schema: Record<string, unknown>,
  options: {
    profileId: DocumentExtractionProfileId;
    subjectId?: string;
    deviceId?: string;
    onTelemetry?: (e: DocumentTelemetryEvent) => void;
  },
): DocumentValidationOk | DocumentValidationFail {
  const subjectId = options.subjectId?.trim() || "subj.document.validate";
  const deviceId = options.deviceId?.trim() || "dev-document";
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer);
  } catch {
    const fail: DocumentValidationFail = {
      ok: false,
      message: "answer is not valid JSON",
      failureClass: "schema",
    };
    emit(options.onTelemetry, {
      op: "validate",
      outcome: "error",
      subjectId,
      deviceId,
      profileId: String(options.profileId),
      failureClass: "schema",
      detail: fail.message,
    });
    return fail;
  }
  const nodeFail = validateAgainstSchemaNode(parsed, schema, "$");
  if (nodeFail) {
    emit(options.onTelemetry, {
      op: "validate",
      outcome: "error",
      subjectId,
      deviceId,
      profileId: String(options.profileId),
      failureClass: nodeFail.failureClass,
      detail: nodeFail.message,
    });
    return nodeFail;
  }
  const value = parsed as Record<string, unknown>;
  const schemaVersion =
    typeof schema.schemaVersion === "string"
      ? schema.schemaVersion
      : String(value.schemaVersion ?? "");
  emit(options.onTelemetry, {
    op: "validate",
    outcome: "ok",
    subjectId,
    deviceId,
    profileId: String(options.profileId),
    schemaVersion,
  });
  return {
    ok: true,
    value,
    profileId: options.profileId,
    schemaVersion,
  };
}

export function loadDocumentFixtureCatalog(
  catalogPath: string = DEFAULT_DOCUMENT_FIXTURE_CATALOG,
): DocumentFixtureCatalog {
  if (!existsSync(catalogPath)) {
    throw new Error(`document fixture catalog missing at ${catalogPath}`);
  }
  const raw = JSON.parse(readFileSync(catalogPath, "utf8")) as DocumentFixtureCatalog;
  if (
    typeof raw.schemaVersion !== "string" ||
    !Array.isArray(raw.fixtures) ||
    raw.fixtures.length < 1
  ) {
    throw new Error(
      "document fixture catalog must declare schemaVersion and non-empty fixtures[]",
    );
  }
  return {
    schemaVersion: raw.schemaVersion,
    ...(raw.description ? { description: raw.description } : {}),
    fixtures: raw.fixtures.slice(0, DOCUMENT_SCHEMA_SCAN_LIMIT).map((f) => ({
      id: f.id,
      profileId: f.profileId,
      schemaRelpath: f.schemaRelpath,
      imageRelpath: f.imageRelpath,
      answerRelpath: f.answerRelpath,
      mimeType: f.mimeType,
      byteLength: f.byteLength,
      maxInputBytes: f.maxInputBytes,
      instruction: f.instruction,
    })),
  };
}

export function loadDocumentFixture(
  fixtureId: string,
  options: { catalogPath?: string } = {},
): DocumentFixture {
  const catalog = loadDocumentFixtureCatalog(
    options.catalogPath ?? DEFAULT_DOCUMENT_FIXTURE_CATALOG,
  );
  const meta = catalog.fixtures.find((f) => f.id === fixtureId);
  if (!meta) {
    throw new Error(`unknown document fixture: ${fixtureId}`);
  }
  const root = path.dirname(options.catalogPath ?? DEFAULT_DOCUMENT_FIXTURE_CATALOG);
  const schemaPath = path.resolve(root, meta.schemaRelpath);
  const imagePath = path.resolve(root, meta.imageRelpath);
  const answerPath = path.resolve(root, meta.answerRelpath);
  for (const p of [schemaPath, imagePath, answerPath]) {
    if (!existsSync(p)) {
      throw new Error(`document fixture path missing: ${p}`);
    }
  }
  const imageBytes = new Uint8Array(readFileSync(imagePath));
  if (imageBytes.byteLength !== meta.byteLength) {
    throw new Error(
      `fixture ${fixtureId} byteLength mismatch: catalog=${meta.byteLength} file=${imageBytes.byteLength}`,
    );
  }
  const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as Record<
    string,
    unknown
  >;
  const answerText = readFileSync(answerPath, "utf8");
  return {
    ...meta,
    schema,
    imageBytes,
    imagePath,
    answerText,
    answerPath,
  };
}

export function loadAllDocumentFixtures(
  options: { catalogPath?: string } = {},
): DocumentFixture[] {
  const catalog = loadDocumentFixtureCatalog(
    options.catalogPath ?? DEFAULT_DOCUMENT_FIXTURE_CATALOG,
  );
  return catalog.fixtures.map((f) =>
    loadDocumentFixture(f.id, {
      ...(options.catalogPath ? { catalogPath: options.catalogPath } : {}),
    }),
  );
}

/**
 * Load profile schema + validate a committed fixture answer (happy-path gate).
 */
export function proveDocumentSchemaFixture(
  fixtureId: string,
  options: {
    subjectId?: string;
    deviceId?: string;
    onTelemetry?: (e: DocumentTelemetryEvent) => void;
  } = {},
): DocumentValidationOk | DocumentValidationFail {
  const fixture = loadDocumentFixture(fixtureId);
  const schema = loadDocumentResponseSchema(fixture.profileId, options);
  return validateDocumentExtractionAnswer(fixture.answerText, schema, {
    profileId: fixture.profileId,
    ...(options.subjectId ? { subjectId: options.subjectId } : {}),
    ...(options.deviceId ? { deviceId: options.deviceId } : {}),
    ...(options.onTelemetry ? { onTelemetry: options.onTelemetry } : {}),
  });
}

export const DEFAULT_PRESCRIPTION_EXTRACT_INSTRUCTION =
  "Extract prescription lines as structured JSON. Use null for illegible drug, dose, or frequency. Never invent medications or diagnoses.";

export type PrescriptionSketchExtractOk = DocumentValidationOk & {
  analysis: VisualAnalysisResult;
};

export type PrescriptionSketchExtractResult =
  | PrescriptionSketchExtractOk
  | DocumentValidationFail;

/**
 * Structured extraction path for prescription-sketch photos: single-page gate,
 * VisionInterface.analyze under the committed prescription responseSchema,
 * then document-schema validation (nullable drug/dose/frequency).
 */
export async function extractPrescriptionSketch(args: {
  vision: VisionInterface;
  input: VisualInput;
  subjectId: string;
  deviceId: string;
  instruction?: string;
  /** When provided as an array length > 1, rejected (single page only). */
  imageBatch?: unknown;
  signal?: AbortSignal;
  onTelemetry?: (e: DocumentTelemetryEvent) => void;
}): Promise<PrescriptionSketchExtractResult> {
  const subjectId = args.subjectId.trim();
  const deviceId = args.deviceId.trim();
  if (!subjectId || !deviceId) {
    const fail: DocumentValidationFail = {
      ok: false,
      message: "extractPrescriptionSketch requires subjectId and deviceId",
      failureClass: "config",
    };
    emit(args.onTelemetry, {
      op: "extract",
      outcome: "error",
      subjectId: subjectId || "",
      deviceId: deviceId || "",
      profileId: PRESCRIPTION_SKETCH_SCHEMA_ID,
      failureClass: "config",
      detail: fail.message,
    });
    return fail;
  }

  const batch = assertSingleDocumentImage(args.imageBatch ?? args.input, {
    subjectId,
    deviceId,
    ...(args.onTelemetry ? { onTelemetry: args.onTelemetry } : {}),
  });
  if (!batch.ok) {
    return batch;
  }

  let schema: Record<string, unknown>;
  try {
    schema = loadDocumentResponseSchema(PRESCRIPTION_SKETCH_SCHEMA_ID, {
      subjectId,
      deviceId,
      ...(args.onTelemetry ? { onTelemetry: args.onTelemetry } : {}),
    });
  } catch (err) {
    const fail: DocumentValidationFail = {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      failureClass: "config",
    };
    emit(args.onTelemetry, {
      op: "extract",
      outcome: "error",
      subjectId,
      deviceId,
      profileId: PRESCRIPTION_SKETCH_SCHEMA_ID,
      failureClass: "config",
      detail: fail.message,
    });
    return fail;
  }

  let analysis: VisualAnalysisResult;
  try {
    analysis = await args.vision.analyze({
      input: args.input,
      instruction:
        args.instruction?.trim() || DEFAULT_PRESCRIPTION_EXTRACT_INSTRUCTION,
      responseSchema: schema,
      ...(args.signal ? { signal: args.signal } : {}),
    });
  } catch (err) {
    const fail: DocumentValidationFail = {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      failureClass: "schema",
    };
    emit(args.onTelemetry, {
      op: "extract",
      outcome: "error",
      subjectId,
      deviceId,
      profileId: PRESCRIPTION_SKETCH_SCHEMA_ID,
      schemaVersion: PRESCRIPTION_SKETCH_SCHEMA_VERSION,
      failureClass: "schema",
      detail: fail.message,
    });
    return fail;
  }

  const validated = validateDocumentExtractionAnswer(analysis.answer, schema, {
    profileId: PRESCRIPTION_SKETCH_SCHEMA_ID,
    subjectId,
    deviceId,
    ...(args.onTelemetry ? { onTelemetry: args.onTelemetry } : {}),
  });
  if (!validated.ok) {
    emit(args.onTelemetry, {
      op: "extract",
      outcome: "error",
      subjectId,
      deviceId,
      profileId: PRESCRIPTION_SKETCH_SCHEMA_ID,
      schemaVersion: PRESCRIPTION_SKETCH_SCHEMA_VERSION,
      failureClass: validated.failureClass,
      detail: validated.message,
    });
    return validated;
  }

  emit(args.onTelemetry, {
    op: "extract",
    outcome: "ok",
    subjectId,
    deviceId,
    profileId: PRESCRIPTION_SKETCH_SCHEMA_ID,
    schemaVersion: validated.schemaVersion,
  });

  return {
    ...validated,
    analysis,
  };
}

/**
 * Conformance prove: run extractPrescriptionSketch on the committed synthetic
 * prescription fixture with a vision binding that returns the golden answer.
 */
export async function provePrescriptionSketchExtraction(
  options: {
    subjectId?: string;
    deviceId?: string;
    vision?: VisionInterface;
    onTelemetry?: (e: DocumentTelemetryEvent) => void;
  } = {},
): Promise<PrescriptionSketchExtractResult> {
  const fixture = loadDocumentFixture("prescription-sketch-probe");
  const subjectId = options.subjectId?.trim() || "subj.prescription.prove";
  const deviceId = options.deviceId?.trim() || "dev-prescription";

  let vision = options.vision;
  let ownedBinding: Awaited<ReturnType<typeof loadLocalVlm>> | null = null;
  if (!vision) {
    ownedBinding = await loadLocalVlm({
      subjectId,
      deviceId,
      maxInputBytes: fixture.maxInputBytes,
      backend: {
        kind: "in-process",
        load: async () => ({ id: "rx-prove" }),
        unload: async () => {},
        analyze: async () => ({
          answer: fixture.answerText.trim(),
          confidence: 0.55,
        }),
      },
    });
    vision = ownedBinding;
  }

  try {
    return await extractPrescriptionSketch({
      vision,
      input: {
        data: fixture.imageBytes,
        mimeType: fixture.mimeType,
      },
      subjectId,
      deviceId,
      instruction: fixture.instruction,
      ...(options.onTelemetry ? { onTelemetry: options.onTelemetry } : {}),
    });
  } finally {
    if (ownedBinding) {
      await ownedBinding.unload();
    }
  }
}

