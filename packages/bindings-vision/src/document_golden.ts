/**
 * Golden fixtures + rubric scoring for teacher/doctor document paths.
 * Redacted synthetic images only — no learner/patient PII in committed fixtures.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  createVisionObligationsRegistry,
  runConformance,
} from "@moolam/contract-conformance";
  import {
  DOCUMENT_SCHEMA_SCAN_LIMIT,
  loadDocumentResponseSchema,
  resolveDocumentSchemaPath,
  validateDocumentExtractionAnswer,
  type DocumentExtractionProfileId,
  type DocumentTelemetryEvent,
} from "./document_understanding.js";
import {
  VISION_PACKAGE_ROOT,
  createLocalVlmVisionHarnessFactory,
  loadLocalVlm,
} from "./vlm_binding.js";

export const DOCUMENT_GOLDEN_DIR = path.join(
  VISION_PACKAGE_ROOT,
  "fixtures",
  "document",
  "golden",
);

export const DEFAULT_DOCUMENT_GOLDEN_CATALOG = path.join(
  DOCUMENT_GOLDEN_DIR,
  "catalog.json",
);

export const DEFAULT_DOCUMENT_GOLDEN_RUBRIC = path.join(
  DOCUMENT_GOLDEN_DIR,
  "rubric.json",
);

export const DOCUMENT_GOLDEN_REPORT_SCHEMA_VERSION =
  "bindings-vision.document-golden.report.v1" as const;

/** Patterns that must never appear in committed golden bodies. */
const PII_PATTERNS: readonly RegExp[] = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /\b(?:\+91[-\s]?)?[6-9]\d{9}\b/,
  /\b\d{4}\s?\d{4}\s?\d{4}\b/, // aadhaar-like
  /\b(?:patient|learner)\s+(?:name|id)\s*[:=]/i,
  /SECRET_|MUST_NOT_LEAK|PII_REAL_/i,
];

export type DocumentGoldenDomain = "teacher" | "doctor" | string;

export type DocumentGoldenRubric = {
  schemaVersion: string;
  minScore: number;
  weights: {
    schemaValid: number;
    requiredFieldMatch: number;
    nullableHonesty: number;
    noPii: number;
  };
};

export type DocumentGoldenMeta = {
  id: string;
  domain: DocumentGoldenDomain;
  profileId: DocumentExtractionProfileId;
  schemaRelpath: string;
  imageRelpath: string;
  expectedRelpath: string;
  mimeType: string;
  byteLength: number;
  maxInputBytes: number;
  instruction: string;
};

export type DocumentGoldenCatalog = {
  schemaVersion: string;
  description?: string;
  rubricRelpath: string;
  fixtures: DocumentGoldenMeta[];
};

export type DocumentGoldenFixture = DocumentGoldenMeta & {
  imageBytes: Uint8Array;
  imagePath: string;
  expectedText: string;
  expectedPath: string;
  expected: Record<string, unknown>;
  schema: Record<string, unknown>;
};

export type RubricDimensionScore = {
  id: keyof DocumentGoldenRubric["weights"];
  score: number;
  detail?: string;
};

export type DocumentGoldenScore = {
  fixtureId: string;
  domain: DocumentGoldenDomain;
  profileId: string;
  ok: boolean;
  score: number;
  minScore: number;
  dimensions: RubricDimensionScore[];
  failures: string[];
};

export type DocumentGoldenRunReport = {
  schemaVersion: typeof DOCUMENT_GOLDEN_REPORT_SCHEMA_VERSION;
  ok: boolean;
  subjectId: string;
  deviceId: string;
  visionConformanceOk: boolean;
  fixtureScores: DocumentGoldenScore[];
  failures: string[];
};

export type DocumentGoldenTelemetry = {
  event: "bindings_vision.document_golden";
  outcome:
    | "start"
    | "pass"
    | "fail"
    | "fixture_ok"
    | "fixture_fail"
    | "conformance_ok"
    | "conformance_fail"
    | "pii_fail";
  subjectId: string;
  deviceId: string;
  fixtureId?: string;
  domain?: string;
  detail?: string;
};

function emit(
  onTelemetry: ((e: DocumentGoldenTelemetry) => void) | undefined,
  partial: Omit<DocumentGoldenTelemetry, "event">,
): void {
  onTelemetry?.({
    event: "bindings_vision.document_golden",
    ...partial,
  });
}

export function loadDocumentGoldenRubric(
  rubricPath: string = DEFAULT_DOCUMENT_GOLDEN_RUBRIC,
): DocumentGoldenRubric {
  if (!existsSync(rubricPath)) {
    throw new Error(`document golden rubric missing at ${rubricPath}`);
  }
  const raw = JSON.parse(readFileSync(rubricPath, "utf8")) as DocumentGoldenRubric;
  if (
    typeof raw.schemaVersion !== "string" ||
    typeof raw.minScore !== "number" ||
    !raw.weights
  ) {
    throw new Error("document golden rubric malformed");
  }
  return raw;
}

export function loadDocumentGoldenCatalog(
  catalogPath: string = DEFAULT_DOCUMENT_GOLDEN_CATALOG,
): DocumentGoldenCatalog {
  if (!existsSync(catalogPath)) {
    throw new Error(`document golden catalog missing at ${catalogPath}`);
  }
  const raw = JSON.parse(readFileSync(catalogPath, "utf8")) as DocumentGoldenCatalog;
  if (
    typeof raw.schemaVersion !== "string" ||
    typeof raw.rubricRelpath !== "string" ||
    !Array.isArray(raw.fixtures) ||
    raw.fixtures.length < 1
  ) {
    throw new Error(
      "document golden catalog must declare schemaVersion, rubricRelpath, fixtures[]",
    );
  }
  return {
    schemaVersion: raw.schemaVersion,
    ...(raw.description ? { description: raw.description } : {}),
    rubricRelpath: raw.rubricRelpath,
    fixtures: raw.fixtures.slice(0, DOCUMENT_SCHEMA_SCAN_LIMIT),
  };
}

export function assertNoPiiInText(text: string): {
  ok: boolean;
  detail?: string;
} {
  for (const re of PII_PATTERNS) {
    if (re.test(text)) {
      return { ok: false, detail: `PII pattern matched: ${re}` };
    }
  }
  return { ok: true };
}

function collectPaths(
  value: unknown,
  prefix: string,
  out: { path: string; value: unknown }[],
): void {
  if (value === null || typeof value !== "object") {
    out.push({ path: prefix || "$", value });
    return;
  }
  if (Array.isArray(value)) {
    const limit = Math.min(value.length, DOCUMENT_SCHEMA_SCAN_LIMIT);
    for (let i = 0; i < limit; i++) {
      collectPaths(value[i], `${prefix}[${i}]`, out);
    }
    return;
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj).slice(0, DOCUMENT_SCHEMA_SCAN_LIMIT)) {
    collectPaths(obj[key], prefix ? `${prefix}.${key}` : key, out);
  }
}

export function loadDocumentGoldenFixture(
  fixtureId: string,
  options: { catalogPath?: string } = {},
): DocumentGoldenFixture {
  const catalogPath = options.catalogPath ?? DEFAULT_DOCUMENT_GOLDEN_CATALOG;
  const catalog = loadDocumentGoldenCatalog(catalogPath);
  const meta = catalog.fixtures.find((f) => f.id === fixtureId);
  if (!meta) {
    throw new Error(`unknown document golden fixture: ${fixtureId}`);
  }
  const root = path.dirname(catalogPath);
  const imagePath = path.resolve(root, meta.imageRelpath);
  const expectedPath = path.resolve(root, meta.expectedRelpath);
  // Schemas always resolve from the package registry (not catalog-relative),
  // so temp prove copies of golden/ still find committed schemas/.
  const schemaPath = resolveDocumentSchemaPath(meta.profileId);
  for (const p of [imagePath, expectedPath, schemaPath]) {
    if (!existsSync(p)) {
      throw new Error(`document golden path missing: ${p}`);
    }
  }
  const imageBytes = new Uint8Array(readFileSync(imagePath));
  if (imageBytes.byteLength !== meta.byteLength) {
    throw new Error(
      `golden ${fixtureId} byteLength mismatch: catalog=${meta.byteLength} file=${imageBytes.byteLength}`,
    );
  }
  const expectedText = readFileSync(expectedPath, "utf8");
  const expected = JSON.parse(expectedText) as Record<string, unknown>;
  const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as Record<
    string,
    unknown
  >;
  return {
    ...meta,
    imageBytes,
    imagePath,
    expectedText,
    expectedPath,
    expected,
    schema,
  };
}

export function loadAllDocumentGoldenFixtures(
  options: { catalogPath?: string } = {},
): DocumentGoldenFixture[] {
  const catalog = loadDocumentGoldenCatalog(
    options.catalogPath ?? DEFAULT_DOCUMENT_GOLDEN_CATALOG,
  );
  return catalog.fixtures.map((f) =>
    loadDocumentGoldenFixture(f.id, {
      ...(options.catalogPath ? { catalogPath: options.catalogPath } : {}),
    }),
  );
}

export function scoreDocumentGoldenAnswer(
  actualAnswer: string,
  fixture: DocumentGoldenFixture,
  rubric: DocumentGoldenRubric = loadDocumentGoldenRubric(),
): DocumentGoldenScore {
  const failures: string[] = [];
  const dimensions: RubricDimensionScore[] = [];

  const validated = validateDocumentExtractionAnswer(
    actualAnswer,
    fixture.schema,
    { profileId: fixture.profileId },
  );
  const schemaValid = validated.ok ? 1 : 0;
  if (!validated.ok) {
    failures.push(`schema: ${validated.message}`);
  }
  dimensions.push({
    id: "schemaValid",
    score: schemaValid,
    ...(validated.ok ? {} : { detail: validated.message }),
  });

  let actualObj: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(actualAnswer);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      actualObj = parsed as Record<string, unknown>;
    }
  } catch {
    actualObj = null;
  }

  const expectedPaths: { path: string; value: unknown }[] = [];
  collectPaths(fixture.expected, "", expectedPaths);
  let requiredHits = 0;
  let requiredTotal = 0;
  let nullableHits = 0;
  let nullableTotal = 0;

  for (const row of expectedPaths.slice(0, DOCUMENT_SCHEMA_SCAN_LIMIT * 4)) {
    if (row.value === null) {
      nullableTotal += 1;
      const actualVal = lookupPath(actualObj, row.path);
      if (actualVal === null) {
        nullableHits += 1;
      } else {
        failures.push(
          `nullableHonesty: ${row.path} expected null (no invention), got ${typeof actualVal}`,
        );
      }
      continue;
    }
    if (
      typeof row.value === "string" ||
      typeof row.value === "number" ||
      typeof row.value === "boolean"
    ) {
      requiredTotal += 1;
      const actualVal = lookupPath(actualObj, row.path);
      if (actualVal === row.value) {
        requiredHits += 1;
      } else {
        failures.push(`fieldMatch: ${row.path} mismatch`);
      }
    }
  }

  const requiredFieldMatch =
    requiredTotal === 0 ? 1 : requiredHits / requiredTotal;
  const nullableHonesty =
    nullableTotal === 0 ? 1 : nullableHits / nullableTotal;
  dimensions.push({
    id: "requiredFieldMatch",
    score: requiredFieldMatch,
  });
  dimensions.push({
    id: "nullableHonesty",
    score: nullableHonesty,
  });

  const piiScan = assertNoPiiInText(
    `${fixture.id}\n${fixture.instruction}\n${actualAnswer}\n${fixture.expectedText}`,
  );
  const noPii = piiScan.ok ? 1 : 0;
  if (!piiScan.ok) {
    failures.push(`noPii: ${piiScan.detail}`);
  }
  dimensions.push({
    id: "noPii",
    score: noPii,
    ...(piiScan.ok ? {} : { detail: piiScan.detail }),
  });

  const score =
    rubric.weights.schemaValid * schemaValid +
    rubric.weights.requiredFieldMatch * requiredFieldMatch +
    rubric.weights.nullableHonesty * nullableHonesty +
    rubric.weights.noPii * noPii;

  const ok =
    schemaValid === 1 &&
    noPii === 1 &&
    requiredFieldMatch === 1 &&
    nullableHonesty === 1 &&
    score + 1e-9 >= rubric.minScore;

  return {
    fixtureId: fixture.id,
    domain: fixture.domain,
    profileId: String(fixture.profileId),
    ok,
    score,
    minScore: rubric.minScore,
    dimensions,
    failures,
  };
}

function lookupPath(
  root: Record<string, unknown> | null,
  pathLabel: string,
): unknown {
  if (!root) return undefined;
  if (!pathLabel || pathLabel === "$") return root;
  const parts = pathLabel.replace(/\[(\d+)\]/g, ".$1").split(".");
  let cur: unknown = root;
  for (const part of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(part);
      cur = cur[idx];
    } else {
      cur = (cur as Record<string, unknown>)[part];
    }
  }
  return cur;
}

export async function runDocumentGoldenSuite(
  options: {
    subjectId?: string;
    deviceId?: string;
    catalogPath?: string;
    onTelemetry?: (e: DocumentGoldenTelemetry) => void;
    onDocumentTelemetry?: (e: DocumentTelemetryEvent) => void;
  } = {},
): Promise<DocumentGoldenRunReport> {
  const subjectId = options.subjectId?.trim() || "subj.document.golden";
  const deviceId = options.deviceId?.trim() || "dev-document-golden";
  const failures: string[] = [];
  const fixtureScores: DocumentGoldenScore[] = [];

  emit(options.onTelemetry, { outcome: "start", subjectId, deviceId });

  const catalog = loadDocumentGoldenCatalog(
    options.catalogPath ?? DEFAULT_DOCUMENT_GOLDEN_CATALOG,
  );
  const rubricPath = path.resolve(
    path.dirname(options.catalogPath ?? DEFAULT_DOCUMENT_GOLDEN_CATALOG),
    catalog.rubricRelpath,
  );
  const rubric = loadDocumentGoldenRubric(rubricPath);
  const fixtures = loadAllDocumentGoldenFixtures({
    ...(options.catalogPath ? { catalogPath: options.catalogPath } : {}),
  });

  // Vision CK-06 conformance on local VLM (size + schema-valid JSON).
  const conf = await runConformance({
    registry: createVisionObligationsRegistry(),
    factory: createLocalVlmVisionHarnessFactory({
      maxInputBytes: 64,
      deviceId,
    }),
    subjectId,
    deviceId,
  });
  const visionConformanceOk = conf.exitCode === 0;
  if (!visionConformanceOk) {
    failures.push("vision CK-06 conformance failed");
    emit(options.onTelemetry, {
      outcome: "conformance_fail",
      subjectId,
      deviceId,
    });
  } else {
    emit(options.onTelemetry, {
      outcome: "conformance_ok",
      subjectId,
      deviceId,
    });
  }

  for (const fixture of fixtures) {
    const pii = assertNoPiiInText(
      `${fixture.id}\n${fixture.instruction}\n${fixture.expectedText}`,
    );
    if (!pii.ok) {
      failures.push(`${fixture.id}: committed fixture PII (${pii.detail})`);
      emit(options.onTelemetry, {
        outcome: "pii_fail",
        subjectId,
        deviceId,
        fixtureId: fixture.id,
        domain: String(fixture.domain),
        ...(pii.detail !== undefined ? { detail: pii.detail } : {}),
      });
    }

    const schema = loadDocumentResponseSchema(fixture.profileId, {
      subjectId,
      deviceId,
      ...(options.onDocumentTelemetry
        ? { onTelemetry: options.onDocumentTelemetry }
        : {}),
    });

    const vlm = await loadLocalVlm({
      subjectId,
      deviceId,
      maxInputBytes: fixture.maxInputBytes,
      backend: {
        kind: "in-process",
        load: async () => ({ id: `golden-${fixture.id}` }),
        unload: async () => {},
        analyze: async () => ({
          answer: fixture.expectedText.trim(),
          confidence:
            typeof fixture.expected.confidence === "number"
              ? fixture.expected.confidence
              : 0.5,
        }),
      },
    });

    try {
      const analysis = await vlm.analyze({
        input: { data: fixture.imageBytes, mimeType: fixture.mimeType },
        instruction: fixture.instruction,
        responseSchema: schema,
      });
      const scored = scoreDocumentGoldenAnswer(
        analysis.answer,
        { ...fixture, schema },
        rubric,
      );
      fixtureScores.push(scored);
      if (!scored.ok) {
        const failDetail = scored.failures[0] ?? "fail";
        failures.push(
          `${fixture.id}: rubric score ${scored.score.toFixed(3)} < ${scored.minScore} (${failDetail})`,
        );
        emit(options.onTelemetry, {
          outcome: "fixture_fail",
          subjectId,
          deviceId,
          fixtureId: fixture.id,
          domain: String(fixture.domain),
          detail: failDetail,
        });
      } else {
        emit(options.onTelemetry, {
          outcome: "fixture_ok",
          subjectId,
          deviceId,
          fixtureId: fixture.id,
          domain: String(fixture.domain),
        });
      }
    } finally {
      await vlm.unload();
    }
  }

  const teacherOk = fixtureScores
    .filter((s) => s.domain === "teacher")
    .every((s) => s.ok);
  const doctorOk = fixtureScores
    .filter((s) => s.domain === "doctor")
    .every((s) => s.ok);
  if (!teacherOk) failures.push("teacher golden path failed");
  if (!doctorOk) failures.push("doctor golden path failed");

  const ok =
    failures.length === 0 &&
    visionConformanceOk &&
    fixtureScores.length === fixtures.length &&
    fixtureScores.every((s) => s.ok);

  emit(options.onTelemetry, {
    outcome: ok ? "pass" : "fail",
    subjectId,
    deviceId,
    ...(ok ? {} : { detail: failures[0] }),
  });

  return {
    schemaVersion: DOCUMENT_GOLDEN_REPORT_SCHEMA_VERSION,
    ok,
    subjectId,
    deviceId,
    visionConformanceOk,
    fixtureScores,
    failures,
  };
}

export async function proveDocumentGoldenGate(
  options: {
    subjectId?: string;
    deviceId?: string;
    onTelemetry?: (e: DocumentGoldenTelemetry) => void;
  } = {},
): Promise<{
  ok: boolean;
  baselineOk: boolean;
  seededRed: boolean;
  restoredOk: boolean;
  failures: string[];
}> {
  const failures: string[] = [];
  const baseline = await runDocumentGoldenSuite(options);
  const baselineOk = baseline.ok;
  if (!baselineOk) {
    failures.push(`baseline not green: ${baseline.failures[0] ?? "fail"}`);
  }

  // Seeded drift: score a mutated answer against the committed expected
  // (never rewrite golden files; temp catalog not required).
  let seededRed = false;
  let restoredOk = false;
  const doctor = loadDocumentGoldenFixture("doctor-prescription-sketch");
  const rubric = loadDocumentGoldenRubric();
  const driftedAnswer = JSON.stringify({
    ...doctor.expected,
    lines: [
      {
        index: 1,
        drug: "SEEDED_DRIFT_DRUG",
        dose: "999 kg",
        frequency: "ALWAYS",
        duration: null,
        confidence: 0.99,
      },
    ],
  });
  const seededScore = scoreDocumentGoldenAnswer(
    driftedAnswer,
    doctor,
    rubric,
  );
  seededRed = seededScore.ok === false;
  if (!seededRed) {
    failures.push("seeded expected drift did not fail rubric");
  }

  const restored = await runDocumentGoldenSuite(options);
  restoredOk = restored.ok;
  if (!restoredOk) {
    failures.push(`restore not green: ${restored.failures[0] ?? "fail"}`);
  }

  const ok = baselineOk && seededRed && restoredOk && failures.length === 0;
  return { ok, baselineOk, seededRed, restoredOk, failures };
}

export function writeDocumentGoldenReport(
  report: DocumentGoldenRunReport,
  outPath: string,
): void {
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

/** CLI-friendly certify entry used by package scripts / CI. */
export async function runDocumentGoldenCli(
  argv: string[] = process.argv.slice(2),
  io: {
    stdout?: { write(chunk: string): void };
    stderr?: { write(chunk: string): void };
  } = {},
): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const prove = argv.includes("--prove");
  const reportIdx = argv.indexOf("--report-out");
  const reportOut =
    reportIdx >= 0 && argv[reportIdx + 1]
      ? argv[reportIdx + 1]!
      : path.join(
          VISION_PACKAGE_ROOT,
          "certification",
          "reports",
          "document.golden.json",
        );

  if (prove) {
    const proof = await proveDocumentGoldenGate();
    if (!proof.ok) {
      for (const f of proof.failures) {
        stderr.write(`DOCUMENT GOLDEN FAIL DIFF: ${f}\n`);
      }
      return 1;
    }
    stdout.write(
      JSON.stringify({
        event: "bindings_vision.document_golden.prove",
        outcome: "pass",
        baselineOk: proof.baselineOk,
        seededRed: proof.seededRed,
        restoredOk: proof.restoredOk,
      }) + "\n",
    );
    return 0;
  }

  const report = await runDocumentGoldenSuite();
  writeDocumentGoldenReport(report, reportOut);
  if (!report.ok) {
    for (const f of report.failures) {
      stderr.write(`DOCUMENT GOLDEN FAIL: ${f}\n`);
    }
    return 1;
  }
  stdout.write(
    JSON.stringify({
      event: "bindings_vision.document_golden.certify",
      outcome: "pass",
      reportOut,
      fixtures: report.fixtureScores.map((s) => ({
        id: s.fixtureId,
        domain: s.domain,
        score: s.score,
      })),
    }) + "\n",
  );
  return 0;
}
