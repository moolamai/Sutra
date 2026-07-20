/**
 * LoRA-class PEFT adapter update path (C4).
 * Run: pnpm --filter sutra-bindings-slm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  ADAPTER_DELTA_SCHEMA_VERSION,
  AdapterTrainContractError,
  LORA_DEFAULT_ALPHA,
  LORA_DEFAULT_RANK,
  LoraAdapterTrainer,
  assertAdapterOnlyUpdate,
  contentAddressDelta,
  pinAdapterTrainLineage,
  proveLoraAdapterUpdateMicroRun,
  synthesizeLoraAdapterDeltaBytes,
} from "../dist/index.js";

const BASE = "ckpt:sha256:lorabase0123456789ab";

test("happy path: LoRA update emits content-addressed delta bound to base hash", () => {
  const events = [];
  const proved = proveLoraAdapterUpdateMicroRun({
    subjectId: "subj.lora.01",
    deviceId: "dev.lora.01",
    baseModelHash: BASE,
    loss: -0.42,
    onTelemetry: (e) => events.push(e),
  });

  assert.equal(proved.ok, true);
  assert.equal(proved.pin.loraRank, LORA_DEFAULT_RANK);
  assert.equal(proved.pin.loraAlpha, LORA_DEFAULT_ALPHA);
  assert.equal(proved.pin.valueHead, false);
  assert.equal(proved.update.ok, true);
  assert.equal(proved.update.artifact.schemaVersion, ADAPTER_DELTA_SCHEMA_VERSION);
  assert.equal(proved.update.artifact.baseModelHash, BASE);
  assert.equal(proved.update.artifact.updateScope, "adapter_only");
  assert.equal(proved.update.artifact.valueHead, false);
  assert.equal(proved.update.artifact.loraRank, 16);
  assert.equal(proved.update.artifact.loraAlpha, 32);
  assert.match(proved.update.artifact.deltaHash, /^sha256:[a-f0-9]{64}$/);
  assert.ok(proved.update.artifact.byteLength > 0);
  assert.equal(proved.update.lineagePin.metadataOnly, false);
  assert.equal(proved.lineage.length, 1);
  assert.ok(events.some((e) => e.event === "bindings.adapter.lora_update"));
  assert.ok(events.some((e) => e.event === "bindings.adapter.delta_emit"));
  assert.ok(events.every((e) => e.valueHead === false));
  assert.ok(events.every((e) => !("content" in e) && !("utterance" in e)));
});

test("edge: base-weight / value-head updates refused; floating latest refused", () => {
  assert.throws(
    () =>
      assertAdapterOnlyUpdate(
        { updateBaseModel: true },
        { subjectId: "subj.lora.01" },
      ),
    (err) =>
      err instanceof AdapterTrainContractError &&
      err.obligation === "adapter.base_weight_forbidden",
  );

  assert.throws(
    () =>
      pinAdapterTrainLineage({
        baseCheckpointHash: "latest",
      }),
    (err) =>
      err instanceof AdapterTrainContractError &&
      err.obligation === "adapter.floating_checkpoint",
  );

  const trainer = new LoraAdapterTrainer({
    subjectId: "subj.lora.01",
    deviceId: "dev.lora.01",
    baseModelHash: BASE,
  });
  assert.throws(
    () =>
      trainer.applyUpdate({
        loss: 0.1,
        valueHead: { hidden: 32 },
      }),
    (err) =>
      err instanceof AdapterTrainContractError &&
      err.obligation === "adapter.value_head_forbidden",
  );
});

test("edge: append-only lineage with parent hash; mid-run base swap refused", () => {
  const trainer = new LoraAdapterTrainer({
    subjectId: "subj.lora.01",
    deviceId: "dev.lora.01",
    baseModelHash: BASE,
  });
  const a = trainer.applyUpdate({ loss: 0.1, updateId: "u1" });
  const b = trainer.applyUpdate({ loss: 0.2, updateId: "u2" });
  assert.equal(b.artifact.parentDeltaHash, a.artifact.deltaHash);
  assert.equal(trainer.lineage().length, 2);
  assert.notEqual(a.artifact.deltaHash, b.artifact.deltaHash);

  assert.throws(
    () =>
      trainer.applyUpdate({
        loss: 0.3,
        baseModelHash: "ckpt:sha256:otherbase0123456789",
      }),
    (err) =>
      err instanceof AdapterTrainContractError &&
      err.obligation === "adapter.lineage_corrupt",
  );
});

test("sovereignty: subjectId required; telemetry stays subject-scoped", () => {
  assert.throws(
    () =>
      new LoraAdapterTrainer({
        subjectId: "",
        deviceId: "dev.lora.01",
        baseModelHash: BASE,
      }),
    (err) =>
      err instanceof AdapterTrainContractError &&
      err.obligation === "adapter.subject_scope",
  );
});

test("idempotent: updateId replay + content-address determinism", () => {
  const events = [];
  const trainer = new LoraAdapterTrainer({
    subjectId: "subj.lora.01",
    deviceId: "dev.lora.01",
    baseModelHash: BASE,
    onTelemetry: (e) => events.push(e),
  });
  const first = trainer.applyUpdate({ loss: 0.55, updateId: "idem.1" });
  const second = trainer.applyUpdate({ loss: 0.55, updateId: "idem.1" });
  assert.equal(second.idempotentReplay, true);
  assert.equal(first.artifact.deltaHash, second.artifact.deltaHash);
  assert.equal(trainer.lineage().length, 1);
  assert.ok(events.some((e) => e.idempotentReplay === true));

  const bytesA = synthesizeLoraAdapterDeltaBytes({
    baseModelHash: BASE,
    rank: 16,
    alpha: 32,
    loss: 0.55,
    step: 0,
  });
  const bytesB = synthesizeLoraAdapterDeltaBytes({
    baseModelHash: BASE,
    rank: 16,
    alpha: 32,
    loss: 0.55,
    step: 0,
  });
  assert.equal(contentAddressDelta(bytesA), contentAddressDelta(bytesB));
  assert.deepEqual(bytesA, bytesB);
});
