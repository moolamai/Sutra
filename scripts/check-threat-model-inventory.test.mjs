/**
 * Unit coverage for threat-model trust boundary inventory gate.
 * Run: node --test scripts/check-threat-model-inventory.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  OBLIGATIONS,
  REQUIRED_CROSSING_IDS,
  REQUIRED_DIAGRAMS,
  REQUIRED_SURFACES,
  checkThreatModelInventory,
  rowForCrossing,
  rowHasClassification,
  rowHasStride,
} from "./check-threat-model-inventory.mjs";

test("happy path: committed THREAT-MODEL + diagrams pass", () => {
  const result = checkThreatModelInventory();
  assert.equal(result.ok, true, result.failures.join("\n"));
  assert.equal(result.crossings, REQUIRED_CROSSING_IDS.length);
  assert.ok(result.diagrams.length >= 4);
  assert.ok(REQUIRED_SURFACES.length === 4);
});

test("row helpers: classification and STRIDE detection", () => {
  const row =
    "| `TB-EDGE-01` | host → EdgeAgent | content (local) | S, I | notes |";
  assert.equal(rowForCrossing(`${row}\n`, "TB-EDGE-01"), row);
  assert.equal(rowHasClassification(row), true);
  assert.equal(rowHasStride(row), true);
  assert.equal(rowHasClassification("| TB-X | a → b | unknown | S |"), false);
});

test("edge: missing crossing fails MISSING_CROSSING", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-threat-"));
  const diagrams = path.join(dir, "diagrams");
  mkdirSync(diagrams);
  try {
    for (const name of [
      "edge-turn-loop.mmd",
      "cloud-agent-sync-path.mmd",
      "sync-wire.mmd",
      "tool-sandbox-seam.mmd",
    ]) {
      writeFileSync(path.join(diagrams, name), "flowchart TB\n", "utf8");
    }
    const body = [
      "# stub",
      ...REQUIRED_SURFACES.map((s) => `surface ${s}`),
      ...REQUIRED_DIAGRAMS.map((d) => d),
      "| `TB-EDGE-01` | a → b | metadata | S | ok |",
      "## Observability contract",
      "subjectId deviceId metadata only never plaintext",
      "## Sovereignty and subject isolation",
      "subjectId cross-subject locality on-device self-hosted",
    ].join("\n");
    writeFileSync(path.join(dir, "THREAT-MODEL.md"), body, "utf8");
    const result = checkThreatModelInventory({
      threatModelPath: path.join(dir, "THREAT-MODEL.md"),
      diagramsDir: diagrams,
    });
    assert.equal(result.ok, false);
    assert.ok(
      result.failures.some((f) => f.startsWith(OBLIGATIONS.MISSING_CROSSING)),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edge: crossing without classification fails CLASSIFICATION", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-threat-cls-"));
  const diagrams = path.join(dir, "diagrams");
  mkdirSync(diagrams);
  try {
    for (const name of [
      "edge-turn-loop.mmd",
      "cloud-agent-sync-path.mmd",
      "sync-wire.mmd",
      "tool-sandbox-seam.mmd",
    ]) {
      writeFileSync(path.join(diagrams, name), "flowchart TB\n", "utf8");
    }
    const rows = REQUIRED_CROSSING_IDS.map((id, i) =>
      i === 0
        ? `| \`${id}\` | a → b | opaque | S | bad |`
        : `| \`${id}\` | a → b | metadata | S | ok |`,
    );
    const body = [
      "# stub",
      ...REQUIRED_SURFACES.map((s) => `surface ${s}`),
      ...REQUIRED_DIAGRAMS.map((d) => d),
      ...rows,
      "## Observability contract",
      "subjectId deviceId metadata only never plaintext",
      "## Sovereignty and subject isolation",
      "subjectId cross-subject locality on-device self-hosted",
    ].join("\n");
    writeFileSync(path.join(dir, "THREAT-MODEL.md"), body, "utf8");
    const result = checkThreatModelInventory({
      threatModelPath: path.join(dir, "THREAT-MODEL.md"),
      diagramsDir: diagrams,
    });
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((f) => f.includes(OBLIGATIONS.CLASSIFICATION)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sovereignty: incomplete sovereignty section fails", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-threat-sov-"));
  const diagrams = path.join(dir, "diagrams");
  mkdirSync(diagrams);
  try {
    for (const name of [
      "edge-turn-loop.mmd",
      "cloud-agent-sync-path.mmd",
      "sync-wire.mmd",
      "tool-sandbox-seam.mmd",
    ]) {
      writeFileSync(path.join(diagrams, name), "flowchart TB\n", "utf8");
    }
    const rows = REQUIRED_CROSSING_IDS.map(
      (id) => `| \`${id}\` | a → b | metadata | S | ok |`,
    );
    const body = [
      "# stub",
      ...REQUIRED_SURFACES.map((s) => `surface ${s}`),
      ...REQUIRED_DIAGRAMS.map((d) => d),
      ...rows,
      "## Observability contract",
      "subjectId deviceId metadata only never plaintext",
      "## Sovereignty and subject isolation",
      "subjectId only — missing locality",
    ].join("\n");
    writeFileSync(path.join(dir, "THREAT-MODEL.md"), body, "utf8");
    const result = checkThreatModelInventory({
      threatModelPath: path.join(dir, "THREAT-MODEL.md"),
      diagramsDir: diagrams,
    });
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((f) => f.includes(OBLIGATIONS.SOVEREIGNTY)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edge: missing STRIDE letter fails STRIDE obligation", () => {
  const row = "| `TB-EDGE-99` | a → b | metadata | — | ok |";
  assert.equal(rowHasStride(row), false);
});
