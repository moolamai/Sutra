/**
 * CK-06 vision conformance fixtures: oversize image, valid schema answer,
 * model-returned invalid JSON — each maps to a B0 vision obligation id.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  VISION_OBLIGATION_IDS,
  validateAnswerAgainstSchema,
} from "@moolam/contract-conformance";
import {
  VisionInputTooLargeError,
  VisionSchemaError,
  createInProcessLocalVlmBackend,
  loadLocalVlm,
  type LocalVlmNativeBackend,
  VISION_PACKAGE_ROOT,
} from "./vlm_binding.js";

export const DEFAULT_CK06_FIXTURE_CATALOG = path.join(
  VISION_PACKAGE_ROOT,
  "fixtures",
  "ck06",
  "catalog.json",
);

export const CK06_FIXTURES_DIR = path.join(
  VISION_PACKAGE_ROOT,
  "fixtures",
  "ck06",
);

export type Ck06FixtureKind =
  | "oversize-image"
  | "schema-valid-answer"
  | "schema-invalid-answer";

export type Ck06FixtureExpect =
  | { outcome: "typed_size_reject"; processedCountDelta: number }
  | { outcome: "schema_valid_json" }
  | { outcome: "typed_schema_reject"; neverReturnProseAsAnswer: boolean };

export type Ck06FixtureMeta = {
  id: string;
  kind: Ck06FixtureKind | string;
  obligationId: "CK-06.1" | "CK-06.2" | string;
  mimeType: string;
  imageRelpath: string;
  byteLength: number;
  maxInputBytes: number;
  instruction: string;
  schemaRelpath?: string;
  answerRelpath?: string;
  expect: Ck06FixtureExpect;
};

export type Ck06FixtureCatalog = {
  schemaVersion: string;
  description?: string;
  engine?: string;
  fixtures: Ck06FixtureMeta[];
};

export type Ck06Fixture = Ck06FixtureMeta & {
  imagePath: string;
  imageBytes: Uint8Array;
  schema?: Record<string, unknown>;
  answerText?: string;
};

export type Ck06FixtureRunResult = {
  fixtureId: string;
  obligationId: string;
  outcome: "pass" | "fail";
  detail?: string;
};

function resultOf(
  fixtureId: string,
  obligationId: string,
  outcome: "pass" | "fail",
  detail?: string,
): Ck06FixtureRunResult {
  return {
    fixtureId,
    obligationId,
    outcome,
    ...(detail !== undefined ? { detail } : {}),
  };
}

function resolveUnderCk06(relpath: string): string {
  const full = path.join(CK06_FIXTURES_DIR, relpath);
  const normalized = path.normalize(full);
  if (!normalized.startsWith(path.normalize(CK06_FIXTURES_DIR))) {
    throw new Error(`fixture path escapes ck06 root: ${relpath}`);
  }
  return normalized;
}

export function loadCk06FixtureCatalog(
  catalogPath: string = DEFAULT_CK06_FIXTURE_CATALOG,
): Ck06FixtureCatalog {
  if (!existsSync(catalogPath)) {
    throw new Error(`CK-06 fixture catalog missing at ${catalogPath}`);
  }
  const raw = JSON.parse(readFileSync(catalogPath, "utf8")) as Partial<Ck06FixtureCatalog>;
  if (
    typeof raw.schemaVersion !== "string" ||
    !Array.isArray(raw.fixtures) ||
    raw.fixtures.length === 0
  ) {
    throw new Error("CK-06 catalog must declare schemaVersion and non-empty fixtures[]");
  }
  const fixtures: Ck06FixtureMeta[] = [];
  for (const f of raw.fixtures.slice(0, 32)) {
    if (
      typeof f?.id !== "string" ||
      !f.id.trim() ||
      typeof f.kind !== "string" ||
      typeof f.obligationId !== "string" ||
      typeof f.mimeType !== "string" ||
      typeof f.imageRelpath !== "string" ||
      typeof f.byteLength !== "number" ||
      !(f.byteLength > 0) ||
      typeof f.maxInputBytes !== "number" ||
      !(f.maxInputBytes > 0) ||
      typeof f.instruction !== "string" ||
      !f.expect ||
      typeof (f.expect as { outcome?: string }).outcome !== "string"
    ) {
      throw new Error(
        "CK-06 fixture requires id, kind, obligationId, image, sizes, instruction, expect",
      );
    }
    if (
      f.obligationId !== VISION_OBLIGATION_IDS.rejectOversized &&
      f.obligationId !== VISION_OBLIGATION_IDS.schemaValidJson
    ) {
      throw new Error(
        `CK-06 fixture ${f.id} obligationId must be CK-06.1 or CK-06.2 (got ${f.obligationId})`,
      );
    }
    fixtures.push({
      id: f.id.trim(),
      kind: f.kind,
      obligationId: f.obligationId,
      mimeType: f.mimeType.trim(),
      imageRelpath: f.imageRelpath,
      byteLength: f.byteLength,
      maxInputBytes: f.maxInputBytes,
      instruction: f.instruction,
      ...(typeof f.schemaRelpath === "string"
        ? { schemaRelpath: f.schemaRelpath }
        : {}),
      ...(typeof f.answerRelpath === "string"
        ? { answerRelpath: f.answerRelpath }
        : {}),
      expect: f.expect as Ck06FixtureExpect,
    });
  }
  return {
    schemaVersion: raw.schemaVersion,
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    ...(typeof raw.engine === "string" ? { engine: raw.engine } : {}),
    fixtures,
  };
}

export function listCk06FixtureIds(
  catalogPath?: string,
): string[] {
  return loadCk06FixtureCatalog(catalogPath).fixtures.map((f) => f.id);
}

export function loadCk06Fixture(
  id: string,
  options: { catalogPath?: string } = {},
): Ck06Fixture {
  const catalog = loadCk06FixtureCatalog(options.catalogPath);
  const meta = catalog.fixtures.find((f) => f.id === id);
  if (!meta) {
    throw new Error(`unknown CK-06 fixture id: ${id}`);
  }
  const imagePath = resolveUnderCk06(meta.imageRelpath);
  if (!existsSync(imagePath)) {
    throw new Error(`CK-06 fixture image missing: ${meta.imageRelpath}`);
  }
  const imageBytes = new Uint8Array(readFileSync(imagePath));
  if (imageBytes.byteLength !== meta.byteLength) {
    throw new Error(
      `CK-06 fixture ${id}: byteLength catalog=${meta.byteLength} disk=${imageBytes.byteLength}`,
    );
  }

  let schema: Record<string, unknown> | undefined;
  if (meta.schemaRelpath) {
    const schemaPath = resolveUnderCk06(meta.schemaRelpath);
    schema = JSON.parse(readFileSync(schemaPath, "utf8")) as Record<
      string,
      unknown
    >;
  }
  let answerText: string | undefined;
  if (meta.answerRelpath) {
    const answerPath = resolveUnderCk06(meta.answerRelpath);
    answerText = readFileSync(answerPath, "utf8");
  }

  return {
    ...meta,
    imagePath,
    imageBytes,
    ...(schema ? { schema } : {}),
    ...(answerText !== undefined ? { answerText } : {}),
  };
}

export function loadAllCk06Fixtures(
  options: { catalogPath?: string } = {},
): Ck06Fixture[] {
  return listCk06FixtureIds(options.catalogPath).map((id) =>
    loadCk06Fixture(id, options),
  );
}

function backendReturningAnswer(answer: string): LocalVlmNativeBackend {
  const inner = createInProcessLocalVlmBackend();
  return {
    kind: inner.kind,
    load: (modelId) => inner.load(modelId),
    unload: (handle) => inner.unload(handle),
    async analyze(handle, params) {
      if (params.responseSchema) {
        return { answer, confidence: 0.5 };
      }
      return inner.analyze(handle, params);
    },
  };
}

/**
 * Execute one CK-06 fixture against the local VLM binding.
 * Maps outcomes to B0 obligation ids (CK-06.1 / CK-06.2).
 */
export async function runCk06Fixture(
  fixture: Ck06Fixture,
  options: {
    subjectId?: string;
    deviceId?: string;
  } = {},
): Promise<Ck06FixtureRunResult> {
  const subjectId = options.subjectId?.trim() || `subj.ck06.${fixture.id}`;
  const deviceId = options.deviceId?.trim() || "ci-vision-ck06";

  if (fixture.expect.outcome === "typed_size_reject") {
    if (fixture.byteLength <= fixture.maxInputBytes) {
      return resultOf(
        fixture.id,
        fixture.obligationId,
        "fail",
        "fixture is not oversized vs maxInputBytes",
      );
    }
    const vlm = await loadLocalVlm({
      subjectId,
      deviceId,
      maxInputBytes: fixture.maxInputBytes,
    });
    const before = vlm.processedCount();
    try {
      await vlm.analyze({
        input: { data: fixture.imageBytes, mimeType: fixture.mimeType },
        instruction: fixture.instruction,
      });
      await vlm.unload();
      return resultOf(
        fixture.id,
        fixture.obligationId,
        "fail",
        "oversized input did not throw",
      );
    } catch (err) {
      const ok =
        err instanceof VisionInputTooLargeError &&
        vlm.processedCount() === before + fixture.expect.processedCountDelta;
      await vlm.unload();
      return resultOf(
        fixture.id,
        fixture.obligationId,
        ok ? "pass" : "fail",
        ok
          ? undefined
          : `expected VisionInputTooLargeError with no processing; got ${
              err instanceof Error ? err.name : String(err)
            } processed=${vlm.processedCount()}`,
      );
    }
  }

  if (fixture.expect.outcome === "schema_valid_json") {
    if (!fixture.schema || fixture.answerText === undefined) {
      return resultOf(
        fixture.id,
        fixture.obligationId,
        "fail",
        "schema/answer fixture missing",
      );
    }
    const validatedFixture = validateAnswerAgainstSchema(
      fixture.answerText.trim(),
      fixture.schema,
    );
    if (!validatedFixture.ok) {
      return resultOf(
        fixture.id,
        fixture.obligationId,
        "fail",
        `committed answer invalid: ${validatedFixture.message}`,
      );
    }
    const vlm = await loadLocalVlm({
      subjectId,
      deviceId,
      maxInputBytes: fixture.maxInputBytes,
      backend: backendReturningAnswer(fixture.answerText.trim()),
    });
    try {
      const result = await vlm.analyze({
        input: { data: fixture.imageBytes, mimeType: fixture.mimeType },
        instruction: fixture.instruction,
        responseSchema: fixture.schema,
      });
      const validated = validateAnswerAgainstSchema(result.answer, fixture.schema);
      await vlm.unload();
      return resultOf(
        fixture.id,
        fixture.obligationId,
        validated.ok ? "pass" : "fail",
        validated.ok ? undefined : validated.message,
      );
    } catch (err) {
      await vlm.unload();
      return resultOf(
        fixture.id,
        fixture.obligationId,
        "fail",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  if (fixture.expect.outcome === "typed_schema_reject") {
    if (!fixture.schema || fixture.answerText === undefined) {
      return resultOf(
        fixture.id,
        fixture.obligationId,
        "fail",
        "schema/answer fixture missing",
      );
    }
    const prose = fixture.answerText;
    const vlm = await loadLocalVlm({
      subjectId,
      deviceId,
      maxInputBytes: fixture.maxInputBytes,
      backend: backendReturningAnswer(prose),
    });
    try {
      const result = await vlm.analyze({
        input: { data: fixture.imageBytes, mimeType: fixture.mimeType },
        instruction: fixture.instruction,
        responseSchema: fixture.schema,
      });
      await vlm.unload();
      if (fixture.expect.neverReturnProseAsAnswer && result.answer === prose) {
        return resultOf(
          fixture.id,
          fixture.obligationId,
          "fail",
          "raw prose returned as answer under responseSchema",
        );
      }
      return resultOf(
        fixture.id,
        fixture.obligationId,
        "fail",
        "invalid model JSON did not throw",
      );
    } catch (err) {
      await vlm.unload();
      const ok = err instanceof VisionSchemaError;
      return resultOf(
        fixture.id,
        fixture.obligationId,
        ok ? "pass" : "fail",
        ok
          ? undefined
          : `expected VisionSchemaError; got ${
              err instanceof Error ? err.name : String(err)
            }`,
      );
    }
  }

  return resultOf(fixture.id, fixture.obligationId, "fail", "unknown expect.outcome");
}

export async function runAllCk06Fixtures(
  options: { subjectId?: string; deviceId?: string; catalogPath?: string } = {},
): Promise<Ck06FixtureRunResult[]> {
  const fixtures = loadAllCk06Fixtures({
    ...(options.catalogPath ? { catalogPath: options.catalogPath } : {}),
  });
  const out: Ck06FixtureRunResult[] = [];
  for (const fixture of fixtures) {
    out.push(
      await runCk06Fixture(fixture, {
        ...(options.subjectId ? { subjectId: options.subjectId } : {}),
        ...(options.deviceId ? { deviceId: options.deviceId } : {}),
      }),
    );
  }
  return out;
}
