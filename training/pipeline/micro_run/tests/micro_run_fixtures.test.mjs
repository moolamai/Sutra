/**
 * Micro-run fixture set assembly (model + corpus + gym).
 * Run: pnpm --filter @moolam/training-pipeline fixtures:test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MicroRunFixtureError,
  lintMicroRunModelStubFile,
  loadMicroRunFixtureSet,
  sha256Of,
} from "../load_fixtures.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "../fixtures");

test("happy path: load pinned micro-run fixture set", () => {
  const events = [];
  const loaded = loadMicroRunFixtureSet({
    fixturesDir: FIXTURES,
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(loaded.set.setId, "c4.micro-run.v1");
  assert.equal(loaded.model.requiresGpu, false);
  assert.equal(loaded.model.allowsNetworkFetch, false);
  assert.equal(loaded.taskPins.length, 3);
  assert.match(loaded.baseModelHash, /^ckpt:sha256:/);
  assert.ok(events.some((e) => e.event === "training.micro_run.fixtures"));
  assert.equal(
    /utterance|keystroke|rawContent/i.test(JSON.stringify(events)),
    false,
  );
});

test("edge: network-fetch model violation fails with DIFF", () => {
  assert.throws(
    () =>
      lintMicroRunModelStubFile(
        path.join(FIXTURES, "violations", "unpinned-network-model.json"),
      ),
    (err) =>
      err instanceof MicroRunFixtureError &&
      err.obligation === "micro_run.network_forbidden" &&
      err.stage === "model" &&
      typeof err.diff === "string",
  );
});

test("edge: contentHash drift prints expected vs actual DIFF", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "micro-run-drift-"));
  try {
    cpSync(FIXTURES, dir, { recursive: true });
    const modelPath = path.join(dir, "model", "slm-stub.json");
    const model = JSON.parse(readFileSync(modelPath, "utf8"));
    model.title = "tampered";
    writeFileSync(modelPath, `${JSON.stringify(model, null, 2)}\n`);
    assert.throws(
      () => loadMicroRunFixtureSet({ fixturesDir: dir }),
      (err) =>
        err instanceof MicroRunFixtureError &&
        err.obligation === "micro_run.pin_drift" &&
        err.stage === "model" &&
        err.diff.includes("expected=") &&
        err.diff.includes("actual="),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sovereignty: cross-subject gym scenario rejected", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "micro-run-scope-"));
  try {
    cpSync(FIXTURES, dir, { recursive: true });
    const scenariosPath = path.join(dir, "gym", "scenarios.json");
    const scenarios = JSON.parse(readFileSync(scenariosPath, "utf8"));
    scenarios.scenarios[0].subjectId = "subj.other";
    const body = `${JSON.stringify(scenarios, null, 2)}\n`;
    writeFileSync(scenariosPath, body);

    const setPath = path.join(dir, "set.manifest.json");
    const setDoc = JSON.parse(readFileSync(setPath, "utf8"));
    setDoc.gym.scenariosContentHash = sha256Of(body);
    writeFileSync(setPath, `${JSON.stringify(setDoc, null, 2)}\n`);

    assert.throws(
      () => loadMicroRunFixtureSet({ fixturesDir: dir }),
      (err) =>
        err instanceof MicroRunFixtureError &&
        err.obligation === "micro_run.subject_scope" &&
        err.stage === "gym",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
