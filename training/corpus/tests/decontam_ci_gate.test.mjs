/**
 * Decontamination CI gate: seeded contamination red; clean sample green + proof.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CORPUS_PACKAGE_ROOT,
  proveDecontaminationCiGate,
  runProveDecontamCli,
} from "../dist/build.js";
import {
  seedContaminatedCorpusWorkspace,
  verifyDecontamProofInBuildReport,
} from "../dist/decontaminate.js";
import {
  assertCorpusBuildDecontamProof,
  loadBaselineRegistryDocumentFromFile,
} from "@moolam/learning";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(PKG_ROOT, "..", "..");
const SECRET = "LEARNER_UTTERANCE_MUST_NOT_LEAK";

test("prove: seeded contamination fails; clean sample passes with proof", () => {
  const events = [];
  const result = proveDecontaminationCiGate({
    packageRoot: CORPUS_PACKAGE_ROOT,
    subjectId: "subj.corpus.prove.decontam.ok",
    deviceId: "dev-decontam-prove",
    onTelemetry: (e) => events.push(e),
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.contaminatedFailed, true);
  assert.equal(result.cleanPassed, true);
  assert.equal(result.proofPresent, true);
  assert.ok((result.registryHashCount ?? 0) >= 1);
  assert.ok(
    events.some((e) => e.op === "prove_decontam" && e.outcome === "ok"),
  );
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test("edge: seedContaminatedCorpusWorkspace writes seeded overlap fixture", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "corpus-seed-contam-"));
  try {
    const smoke = path.join(
      REPO_ROOT,
      "training",
      "eval",
      "fixtures",
      "smoke-baseline.json",
    );
    assert.ok(existsSync(smoke));
    const seeded = seedContaminatedCorpusWorkspace({
      workspaceRoot: tmp,
      evalArtifactAbsPath: smoke,
      baselineRegistryRelpath: path.join(
        REPO_ROOT,
        "training",
        "eval",
        "baseline_registry.json",
      ),
    });
    assert.ok(existsSync(seeded.manifestPath));
    assert.ok(
      existsSync(path.join(tmp, ...seeded.contaminatedSourceRelpath.split("/"))),
    );
    assert.match(seeded.contentHash, /^sha256:[a-f0-9]{64}$/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("edge: proof verifier rejects missing registryHashCount", () => {
  const regPath = path.join(
    REPO_ROOT,
    "training",
    "eval",
    "baseline_registry.json",
  );
  const loaded = loadBaselineRegistryDocumentFromFile(regPath);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;

  const bad = assertCorpusBuildDecontamProof(loaded.document, {
    status: "passed",
    method: "exact_hash",
    checkedHashCount: 2,
    registryHashCount: 0,
  });
  assert.equal(bad.ok, false);

  const via = verifyDecontamProofInBuildReport(loaded.document, {
    status: "skipped",
    checkedHashCount: 1,
  });
  assert.equal(via.ok, false);
});

test("sovereignty: prove telemetry is subject-scoped; no raw content", () => {
  const events = [];
  proveDecontaminationCiGate({
    packageRoot: CORPUS_PACKAGE_ROOT,
    subjectId: "subj.corpus.prove.decontam.iso",
    deviceId: "dev-decontam-iso",
    onTelemetry: (e) => events.push(e),
  });
  const proveEvents = events.filter((e) => e.op === "prove_decontam");
  assert.ok(proveEvents.length >= 1);
  for (const e of proveEvents) {
    assert.equal(e.subjectId, "subj.corpus.prove.decontam.iso");
    assert.equal(e.deviceId, "dev-decontam-iso");
  }
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test("CLI: prove-decontam exits 0", () => {
  const code = runProveDecontamCli([], {
    stdout: { write: () => {} },
    stderr: { write: () => {} },
  });
  assert.equal(code, 0);
});
