/**
 * Generate wire-shape fixtures from Track A frozen JSON Schema export.
 *
 * Source of truth: packages/sync-protocol/schemas/*.json (+ golden envelope
 * composition for nested CognitiveState — never hand-written shapes).
 *
 * Output: packages/contract-conformance/fixtures/wire/bundle.json
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.join(__dirname, "..");
const REPO = path.join(PKG, "..", "..");
const SCHEMA_DIR = path.join(REPO, "packages", "sync-protocol", "schemas");
const GOLDEN = path.join(
  REPO,
  "packages",
  "sync-protocol",
  "fixtures",
  "wire-parity",
  "golden-envelopes.json",
);
const OUT_DIR = path.join(PKG, "fixtures", "wire");
const OUT = path.join(OUT_DIR, "bundle.json");

function loadJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function deepClone(value) {
  return structuredClone(value);
}

/** Compose SyncRequest entirely from committed golden + schema.required. */
function buildValidSyncRequest(schema, golden) {
  const required = schema.required;
  if (!Array.isArray(required) || required.length === 0) {
    throw new Error("SyncRequest schema missing required[]");
  }
  const payload = {
    ...deepClone(golden.syncRequest),
    edgeState: deepClone(golden.cognitiveState),
  };
  for (const key of required) {
    if (!(key in payload)) {
      throw new Error(`golden composition missing required field '${key}'`);
    }
  }
  return payload;
}

/** One violation per top-level required field: omit that key. */
function buildViolations(schema, valid) {
  return schema.required.map((field) => {
    const payload = deepClone(valid);
    delete payload[field];
    return {
      field,
      kind: "missing-required",
      payload,
    };
  });
}

const schema = loadJson(path.join(SCHEMA_DIR, "SyncRequest.json"));
const golden = loadJson(GOLDEN);
const valid = buildValidSyncRequest(schema, golden);
const violations = buildViolations(schema, valid);

mkdirSync(OUT_DIR, { recursive: true });
const bundle = {
  note: "GENERATED — do not hand-edit. Source: sync-protocol/schemas + wire-parity golden.",
  generatedFrom: {
    schema: "packages/sync-protocol/schemas/SyncRequest.json",
    golden: "packages/sync-protocol/fixtures/wire-parity/golden-envelopes.json",
  },
  schemaTitle: schema.title,
  schemaProtocolVersion: schema["x-protocol-version"],
  topLevelRequired: [...schema.required],
  schema,
  valid,
  violations,
};

writeFileSync(OUT, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
console.log(
  `wrote ${path.relative(REPO, OUT)} (${violations.length} violation fixtures for ${schema.required.join(", ")})`,
);
