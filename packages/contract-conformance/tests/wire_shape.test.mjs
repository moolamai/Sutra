/**
 * Wire-shape obligations — frozen SyncRequest schema .
 * Run: pnpm --filter @moolam/contract-conformance test
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSyncRequestValidator,
  createWireShapeRegistry,
  formatAjvErrors,
  loadWireFixtureBundle,
  runConformance,
  scopedValidSyncRequest,
  validSyncRequestProducer,
  violationSyncRequestProducer,
  wireFixtureBundlePath,
  WIRE_OBLIGATION_IDS,
} from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FROZEN_SCHEMA = path.join(
  __dirname,
  "../../sync-protocol/schemas/SyncRequest.json",
);

test("bundle embeds frozen SyncRequest schema bytes from Track A export", () => {
  const bundle = loadWireFixtureBundle();
  const frozen = JSON.parse(readFileSync(FROZEN_SCHEMA, "utf8"));
  assert.equal(bundle.schemaTitle, "SyncRequest");
  assert.deepEqual(bundle.schema, frozen);
  assert.equal(bundle.schemaProtocolVersion, frozen["x-protocol-version"]);
  assert.ok(wireFixtureBundlePath().endsWith(`${path.sep}bundle.json`));
});

test("valid fixture validates against frozen schema (Ajv)", () => {
  const bundle = loadWireFixtureBundle();
  const validate = createSyncRequestValidator(bundle.schema);
  assert.equal(validate(bundle.valid), true, formatAjvErrors(validate.errors));
});

test("one violation fixture per top-level required field is rejected", () => {
  const bundle = loadWireFixtureBundle();
  assert.deepEqual(
    bundle.violations.map((v) => v.field).sort(),
    [...bundle.topLevelRequired].sort(),
  );
  const validate = createSyncRequestValidator(bundle.schema);
  for (const violation of bundle.violations) {
    assert.equal(
      validate(violation.payload),
      false,
      `expected rejection for missing ${violation.field}`,
    );
  }
});

test("happy path: valid producer passes wire obligations", async () => {
  const bundle = loadWireFixtureBundle();
  const registry = createWireShapeRegistry(bundle);
  const report = await runConformance({
    registry,
    factory: () => validSyncRequestProducer(bundle),
    subjectId: "subj-wire",
    deviceId: "edge-aaaa",
  });
  assert.equal(report.exitCode, 0);
  assert.equal(report.passed, 2);
  assert.ok(
    report.verdicts.every((v) =>
      Object.values(WIRE_OBLIGATION_IDS).includes(v.obligationId),
    ),
  );
});

test("seeded violation fails SYNC-01.1 exactly; subject check still runs", async () => {
  const bundle = loadWireFixtureBundle();
  const missingDevice = bundle.violations.find((v) => v.field === "deviceId");
  assert.ok(missingDevice);
  const registry = createWireShapeRegistry(bundle);
  const report = await runConformance({
    registry,
    factory: () => violationSyncRequestProducer(missingDevice),
    subjectId: "subj-bad-wire",
    obligationIds: [WIRE_OBLIGATION_IDS.syncRequestValidates],
  });
  assert.equal(report.exitCode, 1);
  assert.equal(report.verdicts.length, 1);
  assert.equal(report.verdicts[0].obligationId, WIRE_OBLIGATION_IDS.syncRequestValidates);
  assert.equal(report.verdicts[0].outcome, "fail");
  assert.match(report.verdicts[0].mustText, /MUST validate/);
});

test("edge: subject isolation fails when edgeState.subjectId drifts", async () => {
  const bundle = loadWireFixtureBundle();
  const registry = createWireShapeRegistry(bundle);
  const report = await runConformance({
    registry,
    factory: () => ({
      produceSyncRequest() {
        // Intentionally leave golden subjectId (anika-k), ignore ctx.
        return structuredClone(bundle.valid);
      },
    }),
    subjectId: "subj-isolated",
    obligationIds: [WIRE_OBLIGATION_IDS.subjectIsolation],
  });
  assert.equal(report.exitCode, 1);
  assert.equal(report.verdicts[0].outcome, "fail");
  assert.equal(report.verdicts[0].obligationId, WIRE_OBLIGATION_IDS.subjectIsolation);
});

test("edge: replay of valid scoped payload stays idempotent under schema", () => {
  const bundle = loadWireFixtureBundle();
  const validate = createSyncRequestValidator(bundle.schema);
  const a = scopedValidSyncRequest(bundle, "subj-replay");
  const b = scopedValidSyncRequest(bundle, "subj-replay");
  assert.deepEqual(a, b);
  assert.equal(validate(a), true);
  assert.equal(validate(b), true);
});

test("edge: missing subjectId still rejected before run", async () => {
  const bundle = loadWireFixtureBundle();
  await assert.rejects(
    () =>
      runConformance({
        registry: createWireShapeRegistry(bundle),
        factory: () => validSyncRequestProducer(bundle),
        subjectId: "  ",
      }),
    /subjectId/,
  );
});
