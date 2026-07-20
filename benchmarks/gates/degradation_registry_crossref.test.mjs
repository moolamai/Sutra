/**
 * Degradation registry ↔ drill cross-reference gate.
 * Run: pnpm --filter @moolam/benchmarks test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadCrossrefDocument,
  loadRegistryFixture,
  verifyRegistryBindings,
  verifyDocAndPaths,
  verifyChaosDrillRows,
  runCrossrefGate,
  CROSSREF_JSON,
} from "../_shared/degradation_registry_crossref.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function log(event) {
  process.stdout.write(
    `${JSON.stringify({
      event: "benchmarks.degradation_crossref.test",
      ...event,
    })}\n`,
  );
}

test("happy path: crossref bindings match default-registry verbatim; drills pass", async () => {
  const gate = await runCrossrefGate({
    subjectId: "subj-xref-happy",
    deviceId: "edge-xref-happy",
  });
  assert.equal(gate.ok, true, JSON.stringify(gate.mismatches));
  assert.equal(gate.binding.ok, true);
  assert.equal(gate.docs.ok, true);
  assert.equal(gate.chaos.ok, true);
  log({ outcome: "ok", case: "full-gate", subjectId: "subj-xref-happy" });
});

test("edge: mutated signalCode fails verbatim registry binding check", () => {
  const loaded = loadCrossrefDocument();
  assert.equal(loaded.ok, true);
  const mutated = structuredClone(loaded.document);
  const row = mutated.rows.find((r) => r.id === "model_read_queue");
  assert.ok(row);
  row.signalCode = "DEGRADE_SEED_DRIFT_INTENTIONAL";
  const registry = loadRegistryFixture();
  const check = verifyRegistryBindings(mutated, registry);
  assert.equal(check.ok, false);
  assert.equal(check.failureClass, "registry_verbatim_mismatch");
  assert.ok(check.mismatches.some((m) => m.id === "model_read_queue"));
  log({ outcome: "ok", case: "signal-drift-detect", subjectId: null });
});

test("edge: ATR-05 / missing-weights expected fields are locked strings", async () => {
  const loaded = loadCrossrefDocument();
  const atr = loaded.document.rows.find((r) => r.id === "cloud_llm_timeout_atr05");
  const miss = loaded.document.rows.find((r) => r.id === "edge_slm_missing_weights");
  assert.equal(atr.expected.freshnessSource, "last-known-good");
  assert.equal(atr.signalCode, "DEGRADE_STALE_READ");
  assert.equal(miss.expected.failureClass, "missing_weights");
  assert.equal(miss.obligationId, "EDGE.SLM_LOAD");

  // Soften expected so a wrong live field fails loud.
  const soft = structuredClone(loaded.document);
  soft.rows = soft.rows.filter((r) => r.id === "cloud_llm_timeout_atr05");
  soft.rows[0].expected.freshnessSource = "fabricated-source";
  const chaos = await verifyChaosDrillRows(soft, {
    subjectId: "subj-xref-atr-edge",
    deviceId: "edge-xref-atr",
  });
  assert.equal(chaos.ok, false);
  assert.ok(
    chaos.mismatches.some((m) => String(m.detail).includes("freshnessSource")),
  );
  log({ outcome: "ok", case: "atr05-lock", subjectId: "subj-xref-atr-edge" });
});

test("sovereignty: crossref doc forbids content keys; rows stay subject-scoped drills", () => {
  const docs = verifyDocAndPaths(loadCrossrefDocument().document);
  assert.equal(docs.ok, true, JSON.stringify(docs.mismatches));
  const doc = readFileSync(
    path.join(__dirname, "../../docs/protocol/DEGRADATION-DRILL-CROSSREF.md"),
    "utf8",
  );
  assert.match(doc, /subjectId/);
  assert.doesNotMatch(doc, /SECRET_UTTERANCE|learner utterance body/i);
  assert.equal(loadCrossrefDocument().document.allowsFabrication, false);
  log({ outcome: "ok", case: "sovereignty-doc", subjectId: null });
});

test("edge: corrupt crossref json (fabrication allowed) is rejected at load", () => {
  const tmp = path.join(__dirname, ".crossref.seed.json");
  const bad = loadCrossrefDocument().document;
  const seed = { ...bad, allowsFabrication: true };
  writeFileSync(tmp, JSON.stringify(seed));
  try {
    const loaded = loadCrossrefDocument(tmp);
    assert.equal(loaded.ok, false);
    assert.equal(loaded.failureClass, "fabrication_or_silent_retry");
  } finally {
    unlinkSync(tmp);
  }
  log({ outcome: "ok", case: "reject-fabrication-flag", subjectId: null });
});

test("crossref json is committed next to chaos runner", () => {
  const src = readFileSync(CROSSREF_JSON, "utf8");
  assert.match(src, /cloud_llm_timeout_atr05/);
  assert.match(src, /DEGRADE_QUEUE_AND_WARN/);
  assert.match(src, /missing_weights/);
});
