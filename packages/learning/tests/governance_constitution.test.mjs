/**
 * Learning constitution draft + worked examples (CONS-001).
 * Run: pnpm --filter @moolam/learning build && node --test packages/learning/tests/governance_constitution.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONSTITUTION_LAWS,
  CONSTITUTION_WORKED_EXAMPLES,
  LEARNING_CONSTITUTION_RELPATH,
  assertConstitutionCoherent,
  assertFullGateStrictBeat,
  assertKnowledgeModeWeightPolicy,
  assertOneSurgeryPerStage,
  challengerStrictlyBeatsChampion,
  loadConstitutionDocument,
} from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const DEVICE_ID = "device.constitution.test";
const SECRET = "SECRET_CONSTITUTION_UTTERANCE";

test("happy path: constitution loads; laws + worked examples coherent", async () => {
  const events = [];
  const loaded = await loadConstitutionDocument({
    repoRoot: REPO_ROOT,
    subjectId: null,
    deviceId: DEVICE_ID,
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(loaded.ok, true, loaded.ok === false ? loaded.detail : "");
  assert.equal(loaded.relpath, LEARNING_CONSTITUTION_RELPATH);

  const coherent = assertConstitutionCoherent(loaded.text, {
    subjectId: null,
    deviceId: DEVICE_ID,
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(coherent.ok, true, coherent.ok === false ? coherent.detail : "");

  assert.equal(CONSTITUTION_LAWS.length, 6);
  for (const law of CONSTITUTION_LAWS) {
    assert.ok(
      loaded.text.includes(law.requiredPhrase),
      `missing law phrase: ${law.requiredPhrase}`,
    );
  }
  for (const example of CONSTITUTION_WORKED_EXAMPLES) {
    assert.ok(
      loaded.text.includes(example.requiredPhrase),
      `missing worked example: ${example.id}`,
    );
  }
  assert.ok(loaded.text.includes("real promotion scenario walkthrough"));
  assert.ok(loaded.text.includes("evaluateChampionChallengerGate"));
  assert.ok(events.some((e) => e.action === "load_constitution" && e.outcome === "ok"));
  assert.ok(events.some((e) => e.action === "assert_coherent" && e.outcome === "ok"));
  assert.ok(!JSON.stringify(events).includes(SECRET));
  assert.ok(!JSON.stringify(events).includes("utterance"));
});

test("edge: law gap and example gap reject with named failure class", async () => {
  const loaded = await loadConstitutionDocument({
    repoRoot: REPO_ROOT,
    deviceId: DEVICE_ID,
  });
  assert.equal(loaded.ok, true);

  const noLaw = assertConstitutionCoherent(
    loaded.text.replace("One surgery per stage", "ONE_SURGERY_REMOVED"),
    { deviceId: DEVICE_ID },
  );
  assert.equal(noLaw.ok, false);
  if (!noLaw.ok) {
    assert.equal(noLaw.failureClass, "law_gap");
    assert.equal(noLaw.lawId, "L1_one_surgery");
  }

  const noExample = assertConstitutionCoherent(
    loaded.text.replace("tie → reject", "TIE_REMOVED"),
    { deviceId: DEVICE_ID },
  );
  assert.equal(noExample.ok, false);
  if (!noExample.ok) {
    assert.equal(noExample.failureClass, "example_gap");
    assert.equal(noExample.exampleId, "promotion_tie_reject");
  }
});

test("edge: worked promotion walkthrough — tie rejects; strict beat promotes", () => {
  const setIds = ["golden_turns", "guidance", "smoke"];
  const champion = {
    golden_turns: 0.9,
    guidance: 0.9,
    smoke: 0.9,
  };
  const tie = assertFullGateStrictBeat(
    champion,
    { golden_turns: 0.92, guidance: 0.9, smoke: 0.93 },
    setIds,
    { subjectId: "subj.promote.tie", deviceId: DEVICE_ID },
  );
  assert.equal(tie.ok, false);
  if (!tie.ok) {
    assert.equal(tie.failureClass, "tie_reject");
    assert.equal(tie.setId, "guidance");
  }
  assert.equal(challengerStrictlyBeatsChampion(0.9, 0.9), false);

  const promote = assertFullGateStrictBeat(
    champion,
    { golden_turns: 0.92, guidance: 0.91, smoke: 0.93 },
    setIds,
    { subjectId: "subj.promote.ok", deviceId: DEVICE_ID },
  );
  assert.equal(promote.ok, true);

  const multi = assertOneSurgeryPerStage(["adapter", "critic"], {
    subjectId: "subj.surgery",
    deviceId: DEVICE_ID,
  });
  assert.equal(multi.ok, false);
  if (!multi.ok) assert.equal(multi.failureClass, "attribution_void");

  const ret = assertKnowledgeModeWeightPolicy("RET", {
    subjectId: "subj.ret",
    deviceId: DEVICE_ID,
  });
  assert.equal(ret.ok, false);
  if (!ret.ok) assert.equal(ret.failureClass, "ret_in_weights");
});

test("edge: missing constitution path is typed failure; load is idempotent", async () => {
  const missing = await loadConstitutionDocument({
    repoRoot: path.join(REPO_ROOT, "does-not-exist"),
    deviceId: DEVICE_ID,
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.failureClass, "missing_constitution");
  }

  const first = await loadConstitutionDocument({
    repoRoot: REPO_ROOT,
    subjectId: "subj.idem",
    deviceId: DEVICE_ID,
  });
  const second = await loadConstitutionDocument({
    repoRoot: REPO_ROOT,
    subjectId: "subj.idem",
    deviceId: DEVICE_ID,
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (first.ok && second.ok) {
    assert.equal(first.text, second.text);
  }
});

test("sovereignty: concurrent subjects keep isolated telemetry subjectIds", async () => {
  const a = [];
  const b = [];
  await Promise.all([
    (async () => {
      const loaded = await loadConstitutionDocument({
        repoRoot: REPO_ROOT,
        subjectId: "subj-a",
        deviceId: "dev-a",
        onTelemetry: (e) => a.push(e),
      });
      assert.equal(loaded.ok, true);
      assertConstitutionCoherent(loaded.text, {
        subjectId: "subj-a",
        deviceId: "dev-a",
        onTelemetry: (e) => a.push(e),
      });
    })(),
    (async () => {
      const loaded = await loadConstitutionDocument({
        repoRoot: REPO_ROOT,
        subjectId: "subj-b",
        deviceId: "dev-b",
        onTelemetry: (e) => b.push(e),
      });
      assert.equal(loaded.ok, true);
      assertConstitutionCoherent(loaded.text, {
        subjectId: "subj-b",
        deviceId: "dev-b",
        onTelemetry: (e) => b.push(e),
      });
    })(),
  ]);
  assert.ok(a.every((e) => e.subjectId === "subj-a"));
  assert.ok(b.every((e) => e.subjectId === "subj-b"));
  assert.ok(!JSON.stringify(a).includes("subj-b"));
  assert.ok(!JSON.stringify(b).includes("subj-a"));
});
