/**
 * Committed schemas/ governance checks — must stay in lockstep with the exporter.
 * Run after build: node --test tests/schemas_committed.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALL_SCHEMA_EXPORT_MAP,
  EVENT_SCHEMA_EXPORT_MAP,
  exportWireSchemas,
} from "../scripts/export-schemas.mjs";
import {
  PROTOCOL_VERSION,
  syncResponseSchema,
  agentTurnRequestSchema,
  agentTurnResponseSchema,
} from "../dist/index.js";
import { EVENT_CATALOG_VERSION } from "@moolam/observability";

const SCHEMAS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "schemas",
);

const EXPECTED_FILES = Object.keys(ALL_SCHEMA_EXPORT_MAP).map((n) => `${n}.json`);

test("committed schemas/ contains every wire envelope file plus README", async () => {
  const entries = await readdir(SCHEMAS_DIR);
  assert.ok(entries.includes("README.md"), "schemas/README.md must be committed");
  for (const fileName of EXPECTED_FILES) {
    assert.ok(entries.includes(fileName), `missing committed schema: ${fileName}`);
  }
});

test("happy path: re-export matches committed schemas byte-for-byte", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sutra-schema-commit-check-"));
  try {
    await exportWireSchemas({ outDir: dir });
    for (const fileName of EXPECTED_FILES) {
      const committed = await readFile(path.join(SCHEMAS_DIR, fileName), "utf8");
      const regenerated = await readFile(path.join(dir, fileName), "utf8");
      assert.equal(
        regenerated,
        committed,
        `${fileName} drifted from exporter — run pnpm schemas:export`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("edge: every committed schema embeds x-protocol-version matching PROTOCOL_VERSION", async () => {
  for (const fileName of EXPECTED_FILES) {
    const doc = JSON.parse(await readFile(path.join(SCHEMAS_DIR, fileName), "utf8"));
    assert.equal(
      doc["x-protocol-version"],
      PROTOCOL_VERSION,
      `${fileName} protocol metadata mismatch`,
    );
    assert.equal(doc.title, fileName.replace(/\.json$/, ""));
    if (fileName.startsWith("Event")) {
      assert.equal(
        doc["x-event-catalog-version"],
        EVENT_CATALOG_VERSION,
        `${fileName} event catalog version mismatch`,
      );
      assert.equal(typeof doc["x-event-type"], "string");
    }
  }
});

test("edge: committed event catalog schemas cover EVENT_SCHEMA_EXPORT_MAP", async () => {
  for (const typeName of Object.keys(EVENT_SCHEMA_EXPORT_MAP)) {
    const fileName = `${typeName}.json`;
    const doc = JSON.parse(await readFile(path.join(SCHEMAS_DIR, fileName), "utf8"));
    assert.equal(doc.title, typeName);
    assert.ok(doc.properties?.type || doc.properties?.payload);
  }
});

test("edge: barrel still exports schemas the exporter cannot invent", () => {
  // Stage-0 gap that 001 closed — without these, schemas:export fails.
  assert.equal(typeof syncResponseSchema.safeParse, "function");
  assert.equal(typeof agentTurnRequestSchema.safeParse, "function");
  assert.equal(typeof agentTurnResponseSchema.safeParse, "function");
});

test("subject-isolation: committed CognitiveState and AgentTurnRequest require subjectId", async () => {
  const cognitive = JSON.parse(
    await readFile(path.join(SCHEMAS_DIR, "CognitiveState.json"), "utf8"),
  );
  const turn = JSON.parse(
    await readFile(path.join(SCHEMAS_DIR, "AgentTurnRequest.json"), "utf8"),
  );
  assert.ok(cognitive.required?.includes("subjectId"));
  assert.ok(turn.required?.includes("subjectId"));
});

test("subject-isolation: committed HarnessFrame requires subjectId on every variant", async () => {
  const doc = JSON.parse(
    await readFile(path.join(SCHEMAS_DIR, "HarnessFrame.json"), "utf8"),
  );
  assert.equal(doc.title, "HarnessFrame");
  const variants = doc.oneOf ?? doc.anyOf ?? [];
  assert.ok(variants.length >= 8, "expected eight frame variants");
  for (const variant of variants) {
    assert.ok(
      variant.required?.includes("subjectId"),
      `variant missing required subjectId: ${JSON.stringify(variant.properties?.type)}`,
    );
    assert.ok(
      variant.required?.includes("sequenceIndex"),
      "variant missing required sequenceIndex",
    );
    assert.ok(
      variant.required?.includes("correlationId"),
      "variant missing required correlationId",
    );
  }
});

test("schemas README documents the regeneration command (reviewer surface)", async () => {
  const readme = await readFile(path.join(SCHEMAS_DIR, "README.md"), "utf8");
  assert.match(readme, /schemas:export/);
  assert.match(readme, /x-protocol-version/);
  assert.match(readme, /subjectId/);
  assert.match(readme, /normalization/i);
});
