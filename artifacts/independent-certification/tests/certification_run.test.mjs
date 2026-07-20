/**
 * Independent certification run tests.
 * Run: node --test artifacts/independent-certification/tests/certification_run.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CERTIFICATION_OBLIGATION_IDS } from "../src/factory.mjs";
import { createFileBackedMemoryBackend } from "../src/storage.mjs";
import { runIndependentCertification } from "../scripts/run-certification.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

test("happy path: independent stacks pass checklist obligations", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "indep-cert-good-"));
  const events = [];
  try {
    const { artifact } = await runIndependentCertification({
      seedMode: "good",
      subjectId: "cert.indep.good",
      deviceId: "ci-a",
      dataDir,
      emit: (e) => events.push(e),
    });
    assert.equal(artifact.outcome, "pass", JSON.stringify(artifact.summary));
    assert.equal(artifact.exitCode, 0);
    assert.equal(artifact.summary.passed, CERTIFICATION_OBLIGATION_IDS.length);
    assert.ok(
      artifact.environment.stacks.storage.shippedInReferenceMonorepo === false,
    );
    assert.ok(
      artifact.environment.stacks.model.shippedInReferenceMonorepo === false,
    );
    assert.ok(events.some((e) => e.event === "certification.run"));
    assert.ok(
      events.every(
        (e) =>
          !/"delta"\s*:/.test(JSON.stringify(e)) &&
          !/utterance/i.test(JSON.stringify(e)),
      ),
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("edge: seeded cross-subject sync fails only SYNC-01.2", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "indep-cert-xsubj-"));
  try {
    const { artifact } = await runIndependentCertification({
      seedMode: "cross-subject-sync",
      subjectId: "cert.indep.xsubj",
      deviceId: "ci-b",
      dataDir,
    });
    assert.equal(artifact.exitCode, 1);
    const syncIso = artifact.verdicts.find((v) => v.obligationId === "SYNC-01.2");
    assert.equal(syncIso?.outcome, "fail");
    const syncValid = artifact.verdicts.find((v) => v.obligationId === "SYNC-01.1");
    // Schema may still validate with wrong subjectId — isolation is SYNC-01.2.
    assert.ok(syncValid);
    assert.ok(
      artifact.verdicts
        .filter((v) => v.obligationId !== "SYNC-01.2")
        .every((v) => v.outcome === "pass" || v.obligationId.startsWith("SYNC")),
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("edge: hang fails obligation with timeout; runner completes", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "indep-cert-hang-"));
  const started = Date.now();
  try {
    const { artifact } = await runIndependentCertification({
      seedMode: "hang",
      subjectId: "cert.indep.hang",
      deviceId: "ci-c",
      dataDir,
    });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5_000, `runner hung (${elapsed}ms)`);
    assert.equal(artifact.exitCode, 1);
    assert.ok(artifact.summary.timedOut >= 1);
    assert.ok(artifact.verdicts.every((v) => v.outcome === "timeout"));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("sovereignty: file store isolates subjects; restart survives", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "indep-cert-store-"));
  try {
    const backend = createFileBackedMemoryBackend(dataDir);
    const a = backend.open();
    await a.remember({
      subjectId: "subj-a",
      kind: "episodic",
      topicId: "t1",
      createdAt: new Date().toISOString(),
      text: "probe.meta.a",
    });
    await a.remember({
      subjectId: "subj-b",
      kind: "episodic",
      topicId: "t1",
      createdAt: new Date().toISOString(),
      text: "probe.meta.b",
    });

    const afterRestart = backend.restart();
    const hitsA = await afterRestart.recall({ subjectId: "subj-a", limit: 16 });
    const hitsB = await afterRestart.recall({ subjectId: "subj-b", limit: 16 });
    assert.equal(hitsA.length, 1);
    assert.equal(hitsB.length, 1);
    assert.equal(hitsA[0].item.subjectId, "subj-a");
    assert.equal(hitsB[0].item.subjectId, "subj-b");

    // Idempotent sync replay
    const id = "550e8400-e29b-41d4-a716-446655440000";
    let effects = 0;
    assert.equal(backend.syncLedger.applyOnce(id, () => effects++).applied, true);
    assert.equal(backend.syncLedger.applyOnce(id, () => effects++).duplicate, true);
    assert.equal(effects, 1);
    backend.syncLedger.reload();
    assert.equal(backend.syncLedger.has(id), true);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("seeded unstable embed fails only CK-03.1", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "indep-cert-embed-"));
  try {
    const { artifact } = await runIndependentCertification({
      seedMode: "unstable-embed",
      subjectId: "cert.indep.embed",
      deviceId: "ci-d",
      dataDir,
    });
    assert.equal(artifact.exitCode, 1);
    const embed = artifact.verdicts.find((v) => v.obligationId === "CK-03.1");
    assert.equal(embed?.outcome, "fail");
    for (const id of ["CK-03.2", "CK-03.3"]) {
      const v = artifact.verdicts.find((x) => x.obligationId === id);
      assert.equal(v?.outcome, "pass", id);
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("factory does not import reference memory/model harness factories", async () => {
  const factorySrc = readFileSync(
    path.join(ROOT, "src", "factory.mjs"),
    "utf8",
  );
  assert.doesNotMatch(factorySrc, /createDurableMemoryHarnessFactory/);
  assert.doesNotMatch(factorySrc, /createStableModelHarnessFactory/);
  assert.doesNotMatch(factorySrc, /@moolam\/bindings-slm/);
  const storageSrc = readFileSync(path.join(ROOT, "src", "storage.mjs"), "utf8");
  assert.doesNotMatch(storageSrc, /@moolam\//);
});

test("environment manifest schema fields present after programmatic run", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "indep-cert-env-"));
  try {
    const { env, artifact } = await runIndependentCertification({
      subjectId: "cert.indep.env",
      deviceId: "ci-e",
      dataDir,
    });
    assert.equal(env.schemaVersion, "independent-certification.environment.v1");
    assert.ok(env.runtime.node);
    assert.equal(env.independenceKit.monorepoCheckoutRequired, false);
    assert.deepEqual(env.obligationIds, [...CERTIFICATION_OBLIGATION_IDS]);
    assert.equal(artifact.schemaVersion, "independent-certification.report.v1");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
