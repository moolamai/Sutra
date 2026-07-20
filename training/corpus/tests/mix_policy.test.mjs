/**
 * Training mix policy governance document + machine mirror.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MIX_CURRICULUM_STAGE_ORDER,
  MIX_MEM_MAX_WEIGHT,
  MIX_POLICY_DOC_RELPATH,
  MIX_POLICY_EXAMPLE_PACK_IDS,
  MIX_REPAIR_TARGET_WEIGHT,
  MIX_REPAIR_TOLERANCE,
  MIX_RET_WEIGHT,
  assertMixPolicyWeights,
  exampleRepairHeavyStageWeights,
  proveMixPolicyDocumentPresent,
  resolveMixPolicyDocumentPath,
} from "../dist/mix_policy.js";
import { PACK_SFT_REPAIR_HEAVY_TARGET_WEIGHT } from "../dist/build.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, "..");

test("happy path: mix policy document present with real pack examples", () => {
  const events = [];
  const proved = proveMixPolicyDocumentPresent({
    packageRoot: PKG_ROOT,
    subjectId: "subj.mix-policy.doc",
    deviceId: "dev-mix-policy",
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(proved.ok, true, JSON.stringify(proved));
  if (!proved.ok) return;

  const abs = resolveMixPolicyDocumentPath(PKG_ROOT);
  assert.ok(abs.endsWith(MIX_POLICY_DOC_RELPATH.replace(/\//g, path.sep)) || abs.includes("MIX_POLICY.md"));
  const text = readFileSync(abs, "utf8");
  for (const packId of MIX_POLICY_EXAMPLE_PACK_IDS) {
    assert.ok(text.includes(packId), `doc must mention ${packId}`);
  }
  assert.ok(text.includes("domains/teacher/README.md"));
  assert.ok(text.includes("knowledge-packs/doctor-formulary-sketch"));
  assert.ok(events.some((e) => e.op === "prove_doc" && e.outcome === "ok"));
  assert.ok(!JSON.stringify(events).includes("utterance"));
});

test("happy path: constants align with curriculum repair target and stage order", () => {
  assert.equal(MIX_REPAIR_TARGET_WEIGHT, 0.5);
  assert.equal(MIX_REPAIR_TARGET_WEIGHT, PACK_SFT_REPAIR_HEAVY_TARGET_WEIGHT);
  assert.equal(MIX_REPAIR_TOLERANCE, 0.05);
  assert.equal(MIX_MEM_MAX_WEIGHT, 0.15);
  assert.equal(MIX_RET_WEIGHT, 0);
  assert.deepEqual([...MIX_CURRICULUM_STAGE_ORDER], [
    "protocol",
    "tool_use",
    "domain_depth",
    "repair",
  ]);

  const example = exampleRepairHeavyStageWeights();
  assert.equal(example.repair, 0.5);
  const sum =
    example.protocol + example.tool_use + example.domain_depth + example.repair;
  assert.ok(Math.abs(sum - 1) < 1e-9);

  const ok = assertMixPolicyWeights(
    {
      stageWeights: example,
      modeWeights: { MEM: 0.1, UND: 0.9, RET: 0 },
      repairSourcesPresent: true,
    },
    { subjectId: "subj.mix-policy.ok", deviceId: "dev-mix" },
  );
  assert.equal(ok.ok, true, JSON.stringify(ok));
});

test("edge: RET in weights is rejected", () => {
  const events = [];
  const result = assertMixPolicyWeights(
    { modeWeights: { MEM: 0, UND: 0.9, RET: 0.1 } },
    {
      subjectId: "subj.mix-policy.ret",
      deviceId: "dev-mix",
      onTelemetry: (e) => events.push(e),
    },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failureClass, "ret_in_weights");
  assert.ok(
    events.some((e) => e.failureClass === "ret_in_weights" && e.outcome === "error"),
  );
});

test("edge: MEM over thin cap is rejected", () => {
  const result = assertMixPolicyWeights({
    modeWeights: { MEM: 0.2, UND: 0.8, RET: 0 },
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failureClass, "mem_over_thin");
});

test("edge: repair out of band when repair sources present", () => {
  const result = assertMixPolicyWeights({
    stageWeights: {
      protocol: 0.3,
      tool_use: 0.3,
      domain_depth: 0.2,
      repair: 0.2,
    },
    repairSourcesPresent: true,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failureClass, "repair_out_of_band");
});

test("sovereignty: replayed validate is idempotent (same outcome)", () => {
  const input = {
    stageWeights: exampleRepairHeavyStageWeights(),
    modeWeights: { MEM: 0, UND: 1, RET: 0 },
    repairSourcesPresent: true,
  };
  const a = assertMixPolicyWeights(input, {
    subjectId: "subj.mix-policy.idem",
    deviceId: "dev-mix",
  });
  const b = assertMixPolicyWeights(input, {
    subjectId: "subj.mix-policy.idem",
    deviceId: "dev-mix",
  });
  assert.deepEqual(a, b);
  assert.equal(a.ok, true);
});
