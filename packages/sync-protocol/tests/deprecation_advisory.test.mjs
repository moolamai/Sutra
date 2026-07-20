/**
 * Deprecation advisory emission on a seeded deprecated field.
 *
 * Happy path: raw CognitiveState carrying the test-only deprecated field emits
 * SyncAdvisory DEPRECATED_FIELD_PRESENT with sunset date on parse.
 * Edge: absent field → no advisory; replay is idempotent; cross-subject fails.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  PROTOCOL_VERSION,
  TEST_ONLY_DEPRECATED_FIELD_PATH,
  TEST_ONLY_DEPRECATED_SUNSET,
  collectDeprecationAdvisories,
  encodeHLC,
  formatDeprecationAdvisoryDetail,
  parseCognitiveStateWithDeprecationAdvisories,
  syncAdvisorySchema,
} from "../dist/index.js";

const DEVICE = "edge-depr-aaaa";
const HLC = encodeHLC(1_700_000_000_000, 1, DEVICE);

function baseState(subjectId = "subj-depr-a") {
  return {
    protocolVersion: PROTOCOL_VERSION,
    subjectId,
    deviceIds: [DEVICE],
    activeConceptId: "math.ratios",
    mode: "exploratory",
    mastery: {
      "math.ratios": {
        conceptId: "math.ratios",
        alpha: { [DEVICE]: 1 },
        beta: { [DEVICE]: 1 },
        lastExercisedAt: HLC,
      },
    },
    frictionLog: [],
    profile: {
      ageBand: "adolescent",
      track: "cbse-class-7-maths",
      language: "hi-IN",
      updatedAt: HLC,
      // Seeded test-only deprecated field (not in production schema; inspected pre-strip).
      __deprTestLegacyLocale: "hi",
    },
    stateVector: { session: HLC },
  };
}

test("happy path: seeded deprecated field emits DEPRECATED_FIELD_PRESENT with sunset", () => {
  const events = [];
  const raw = baseState();
  const { state, advisories } = parseCognitiveStateWithDeprecationAdvisories(
    raw,
    {
      subjectId: "subj-depr-a",
      deviceId: DEVICE,
      emit: (e) => events.push(e),
    },
  );

  assert.equal(state.subjectId, "subj-depr-a");
  // Schema strip: test-only key must not survive into typed state.
  assert.equal(
    Object.hasOwn(state.profile, "__deprTestLegacyLocale"),
    false,
  );

  assert.equal(advisories.length, 1);
  assert.equal(advisories[0].code, "DEPRECATED_FIELD_PRESENT");
  assert.match(advisories[0].detail, new RegExp(`field=${TEST_ONLY_DEPRECATED_FIELD_PATH}`));
  assert.match(
    advisories[0].detail,
    new RegExp(`sunset=${TEST_ONLY_DEPRECATED_SUNSET}`),
  );
  assert.match(advisories[0].detail, /testOnly=true/);
  assert.equal(
    syncAdvisorySchema.parse(advisories[0]).code,
    "DEPRECATED_FIELD_PRESENT",
  );

  assert.ok(
    events.some(
      (e) =>
        e.event === "protocol.deprecation" &&
        e.outcome === "advisory_emitted" &&
        e.subjectId === "subj-depr-a" &&
        e.deviceId === DEVICE &&
        e.field === TEST_ONLY_DEPRECATED_FIELD_PATH &&
        e.sunsetDate === TEST_ONLY_DEPRECATED_SUNSET,
    ),
  );
  // Never log the deprecated field's value (learner-adjacent).
  assert.ok(!JSON.stringify(events).includes('"hi"'));
  assert.doesNotMatch(advisories[0].detail, /\bhi\b/);
});

test("edge: absent deprecated field emits no advisory (idempotent absence)", () => {
  const events = [];
  const raw = baseState();
  delete raw.profile.__deprTestLegacyLocale;
  const advisories = collectDeprecationAdvisories(raw, {
    subjectId: "subj-depr-a",
    deviceId: DEVICE,
    emit: (e) => events.push(e),
  });
  assert.deepEqual(advisories, []);
  assert.ok(events.every((e) => e.outcome === "absent"));
});

test("edge: replay of the same seeded payload is idempotent", () => {
  const raw = baseState("subj-depr-replay");
  const first = collectDeprecationAdvisories(raw, {
    subjectId: "subj-depr-replay",
    deviceId: DEVICE,
  });
  const second = collectDeprecationAdvisories(raw, {
    subjectId: "subj-depr-replay",
    deviceId: DEVICE,
  });
  assert.deepEqual(first, second);
  assert.equal(first.length, 1);
  assert.equal(
    first[0].detail,
    formatDeprecationAdvisoryDetail({
      path: TEST_ONLY_DEPRECATED_FIELD_PATH,
      sunsetDate: TEST_ONLY_DEPRECATED_SUNSET,
      testOnly: true,
      replacement: "profile.language",
    }),
  );
});

test("edge: concurrent subjects do not cross-wire deprecation scope", () => {
  const a = collectDeprecationAdvisories(baseState("subj-a"), {
    subjectId: "subj-a",
    deviceId: "dev-a",
  });
  const bRaw = baseState("subj-b");
  delete bRaw.profile.__deprTestLegacyLocale;
  const b = collectDeprecationAdvisories(bRaw, {
    subjectId: "subj-b",
    deviceId: "dev-b",
  });
  assert.equal(a.length, 1);
  assert.equal(b.length, 0);

  assert.throws(
    () =>
      parseCognitiveStateWithDeprecationAdvisories(baseState("subj-a"), {
        subjectId: "subj-b",
        deviceId: "dev-b",
      }),
    /subjectId mismatch/,
  );
});

test("edge: empty subjectId fails closed before advisory scan", () => {
  assert.throws(
    () =>
      collectDeprecationAdvisories(baseState(), {
        subjectId: "   ",
        deviceId: DEVICE,
      }),
    /subjectId is required/,
  );
});
