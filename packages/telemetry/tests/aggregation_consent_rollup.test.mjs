/**
 * AGGRCONT-003 — golden friction → expected rollups; consent rejection paths.
 * Run: pnpm --filter @moolam/telemetry test (after build)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGGREGATION_GOLDEN_FIXTURES_RELPATH,
  AGGREGATION_GOLDEN_MANIFEST,
  AggregationConsentError,
  SubjectScopedAggregationSeam,
  assertAggregationExportConsentOrThrow,
  buildFrictionAggregationRollup,
  emitAggregationObservability,
  enqueueAggregationWrite,
  parseFrictionAggregationRollup,
  raiseAggregationConsentError,
  rollupLocalFrictionSamples,
} from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(__dirname, "..", AGGREGATION_GOLDEN_FIXTURES_RELPATH);

function loadJson(relPath) {
  return JSON.parse(readFileSync(join(FIXTURE_ROOT, relPath), "utf8"));
}

const manifest = loadJson(AGGREGATION_GOLDEN_MANIFEST);

function log(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

test("manifest documents golden rollups and consent rejection fixtures", () => {
  assert.equal(manifest.schemaVersion, "aggregation.v1");
  assert.ok(manifest.rollups.length >= 2);
  assert.ok(manifest.consentRejections.length >= 2);
  assert.ok(
    manifest.consentRejections.some((c) => c.expectedObligation === "consent_missing"),
  );
  assert.ok(
    manifest.consentRejections.some((c) => c.expectedObligation === "consent_expired"),
  );
});

for (const entry of manifest.rollups) {
  test(`golden rollup: ${entry.id}`, () => {
    const fixture = loadJson(entry.file);
    const built = buildFrictionAggregationRollup({
      ...fixture.input,
      samples: fixture.samples,
    });
    assert.equal(built.ok, true, built.ok === false ? built.detail : "");
    assert.deepEqual(built.record, fixture.expectedRollup);
    assert.equal(built.record.sampleCount, entry.expectSampleCount);
    assert.equal(built.record.concepts.length, entry.expectConceptCount);

    const roundTrip = parseFrictionAggregationRollup(
      JSON.parse(JSON.stringify(built.record)),
    );
    assert.equal(roundTrip.ok, true);
    assert.deepEqual(roundTrip.record, fixture.expectedRollup);

    const gated = rollupLocalFrictionSamples({
      ...fixture.input,
      samples: fixture.samples,
      resolveConsent: () => fixture.consent,
    });
    assert.equal(gated.ok, true);
    assert.deepEqual(gated.record, fixture.expectedRollup);

    // Behavioral metadata only — no raw content keys on the wire shape.
    assert.ok(!("keystrokes" in built.record));
    assert.ok(!("prompt" in built.record));
    assert.ok(!("utterance" in built.record));

    emitAggregationObservability({
      event: "telemetry.aggregation.golden",
      outcome: "ok",
      subjectId: built.record.subjectId,
      deviceId: built.record.deviceId,
      sampleCount: built.record.sampleCount,
      conceptCount: built.record.concepts.length,
    });
    log({
      event: "telemetry.aggregation.golden",
      outcome: "ok",
      fixtureId: entry.id,
      subjectId: built.record.subjectId,
      deviceId: built.record.deviceId,
    });
  });
}

for (const entry of manifest.consentRejections) {
  test(`consent rejection: ${entry.id} → AggregationConsentError(${entry.expectedObligation})`, () => {
    const fixture = loadJson(entry.file);
    assert.equal(fixture.expectedObligation, entry.expectedObligation);

    const built = buildFrictionAggregationRollup({
      ...fixture.input,
      samples: fixture.samples,
    });
    assert.equal(built.ok, true);

    assert.throws(
      () =>
        assertAggregationExportConsentOrThrow(
          built.record,
          () => fixture.consent,
          { nowIso: fixture.nowIso, deviceId: fixture.input.deviceId },
        ),
      (err) => {
        assert.ok(err instanceof AggregationConsentError);
        assert.equal(err.name, "AggregationConsentError");
        assert.equal(err.obligation, entry.expectedObligation);
        assert.equal(err.subjectId, fixture.input.subjectId);
        assert.equal(err.consentRecordId, fixture.input.consentRecordId);
        assert.equal(err.deviceId, fixture.input.deviceId);
        assert.ok(!("keystrokes" in err));
        assert.ok(!("prompt" in err));
        return true;
      },
    );

    const local = rollupLocalFrictionSamples({
      ...fixture.input,
      samples: fixture.samples,
      resolveConsent: () => fixture.consent,
      nowIso: fixture.nowIso,
    });
    // rollupLocalFrictionSamples uses assertAggregationExportConsent (result),
    // not OrThrow — still rejects with the same obligation class.
    assert.equal(local.ok, false);
    assert.equal(local.failureClass, entry.expectedObligation);

    log({
      event: "telemetry.aggregation.consent",
      outcome: "rejected",
      fixtureId: entry.id,
      subjectId: fixture.input.subjectId,
      deviceId: fixture.input.deviceId,
      failureClass: entry.expectedObligation,
    });
  });
}

test("edge: raiseAggregationConsentError preserves typed obligation", () => {
  assert.throws(
    () =>
      raiseAggregationConsentError({
        failureClass: "consent_missing",
        detail: "consent record not found",
        subjectId: "learner-a",
        consentRecordId: "c-1",
        deviceId: "edge-dev1",
      }),
    (err) => {
      assert.ok(err instanceof AggregationConsentError);
      assert.equal(err.obligation, "consent_missing");
      return true;
    },
  );
});

test("edge: async write never blocks turn after golden rollup", async () => {
  const fixture = loadJson(manifest.rollups[0].file);
  const built = buildFrictionAggregationRollup({
    ...fixture.input,
    samples: fixture.samples,
  });
  assert.equal(built.ok, true);

  let done = false;
  const events = [];
  const queued = enqueueAggregationWrite(
    built.record,
    async () => {
      await new Promise((r) => setTimeout(r, 25));
      done = true;
    },
    { onTelemetry: (e) => events.push(e) },
  );
  assert.equal(queued.queued, true);
  assert.equal(done, false);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(done, true);
  assert.ok(events.some((e) => e.outcome === "ok"));
});

test("sovereignty: edge seam rejects cross-subject before storage with typed error path", async () => {
  const fixture = loadJson("consent/cross-subject-consent.json");
  let queries = 0;
  const seam = new SubjectScopedAggregationSeam({
    subjectId: "learner-a",
    driver: {
      async execute() {},
      async query() {
        queries += 1;
        return [];
      },
    },
    resolveConsent: async () => fixture.consent,
  });

  const result = await seam.rollup({
    subjectId: "learner-b",
    deviceId: fixture.input.deviceId,
    consentRecordId: fixture.input.consentRecordId,
    rolledUpAt: fixture.input.rolledUpAt,
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, "cross_subject");
  assert.equal(queries, 0);

  assert.throws(
    () =>
      raiseAggregationConsentError({
        failureClass: result.failureClass,
        detail: result.detail,
        subjectId: result.subjectId,
        consentRecordId: fixture.input.consentRecordId,
        deviceId: fixture.input.deviceId,
      }),
    (err) => err instanceof AggregationConsentError && err.obligation === "cross_subject",
  );
});

test("scalability: golden fixture sample counts stay within soft caps", () => {
  for (const entry of manifest.rollups) {
    const fixture = loadJson(entry.file);
    assert.ok(fixture.samples.length <= 4096);
    assert.ok(fixture.expectedRollup.concepts.length <= 512);
  }
});
