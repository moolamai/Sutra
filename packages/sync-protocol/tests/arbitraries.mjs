/**
 * Structured fast-check arbitraries for CRDT property tests.
 *
 * Leaf types
 *   - HLC strings with controllable physical / logical / deviceId
 *   - G-Counter shard maps (empty / single / multi-device)
 *   - FrictionSample sets, including deliberate capturedAt collisions
 *
 * Full CognitiveState
 *   - Tunable replica overlap + deliberate equal-HLC injection
 *   - Empty / single-shard / disjoint-key biases
 *   - Every emission validated against cognitiveStateSchema
 *
 * @module arbitraries
 */

import * as fc from "fast-check";
import {
  encodeHLC,
  PROTOCOL_VERSION,
  hlcSchema,
  frictionSampleSchema,
  conceptMasterySchema,
  cognitiveStateSchema,
} from "../dist/index.js";

/** Fixed seed for CI-seeded property runs (reproducible). */
export const CI_ARBITRARY_SEED = 0xa01_c0d3;

/** Nightly / local exploration leaves seed unset. */
export const CI_NUM_RUNS = 10_000;

/** Bound generation so property suites stay within NFR budgets. */
export const MAX_SHARDS = 8;
export const MAX_FRICTION_SAMPLES = 16;
export const MAX_CONCEPTS = 6;
export const MAX_STATE_VECTOR_KEYS = 6;

const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;
const FORBIDDEN_DEVICE_IDS = new Set([
  "toString",
  "valueOf",
  "constructor",
  "__proto__",
  "hasOwnProperty",
  "toLocaleString",
  "isPrototypeOf",
  "propertyIsEnumerable",
]);

const GUIDANCE_MODES = /** @type {const} */ ([
  "exploratory",
  "guided",
  "reinforcement",
  "prerequisite-remediation",
  "diagnostic",
]);

const AGE_BANDS = /** @type {const} */ (["child", "adolescent", "adult"]);

/** Structured observability — never learner content. */
export function emitArbitraryEvent(event) {
  process.stdout.write(`${JSON.stringify({ event: "crdt.arbitrary", ...event })}\n`);
}

/**
 * Device ids that satisfy the HLC wire regex (4–64 of [A-Za-z0-9_-]).
 * Prefers short, shrinkable strings.
 */
export const deviceIdArb = fc
  .stringMatching(/^[A-Za-z0-9_-]{4,16}$/)
  .filter((id) => DEVICE_ID_PATTERN.test(id) && !FORBIDDEN_DEVICE_IDS.has(id));

/** Synthetic subject ids — never learner free text. */
export const subjectIdArb = fc.stringMatching(/^[a-z][a-z0-9_-]{2,32}$/);

/** Synthetic concept ids (knowledge-graph node keys). */
export const conceptIdArb = fc.stringMatching(/^[a-z][a-z0-9._-]{2,24}$/);

/**
 * Controllable HLC triple. Physical/logical stay within encodeHLC pad widths.
 *
 * @param {{ physical?: fc.Arbitrary<number>, logical?: fc.Arbitrary<number>, deviceId?: fc.Arbitrary<string> }} [opts]
 */
export function hlcArb(opts = {}) {
  // Wire regex is `\d{15}` — keep physical within 15 decimal digits.
  const physical =
    opts.physical ?? fc.integer({ min: 0, max: 999_999_999_999_999 });
  const logical = opts.logical ?? fc.integer({ min: 0, max: 999_999 });
  const deviceId = opts.deviceId ?? deviceIdArb;
  return fc
    .record({ physical, logical, deviceId })
    .map(({ physical: p, logical: l, deviceId: d }) => encodeHLC(p, l, d));
}

/**
 * Deliberate equal physical+logical timestamps from *different* deviceIds —
 * the tie-break surface where merge bugs hide.
 */
export const equalHlcDifferentDevicesArb = fc
  .tuple(
    fc.integer({ min: 0, max: 999_999_999_999_999 }),
    fc.integer({ min: 0, max: 999_999 }),
    deviceIdArb,
    deviceIdArb,
  )
  .filter(([, , a, b]) => a !== b)
  .map(([physical, logical, deviceA, deviceB]) => ({
    physical,
    logical,
    a: encodeHLC(physical, logical, deviceA),
    b: encodeHLC(physical, logical, deviceB),
    deviceA,
    deviceB,
  }));

/**
 * G-Counter shard map: deviceId → nonnegative finite count.
 * Biased toward empty, single-shard, and multi-device cases.
 *
 * Pass `devicePool` (string[]) when the device alphabet is fixed — never
 * `uniqueArray` over a singleton constant (that rejects forever).
 *
 * @param {{ maxShards?: number, deviceIds?: fc.Arbitrary<string>, devicePool?: string[] }} [opts]
 */
export function gCounterShardsArb(opts = {}) {
  const maxShards = opts.maxShards ?? MAX_SHARDS;
  const pool = opts.devicePool;
  const deviceIds = opts.deviceIds ?? deviceIdArb;
  const empty = fc.constant({});

  if (pool && pool.length > 0) {
    const single = fc
      .tuple(fc.constantFrom(...pool), fc.float({ min: 0, max: 1e6, noNaN: true }))
      .map(([id, n]) => ({ [id]: Math.abs(n) }));
    if (pool.length === 1) {
      return fc.oneof(
        { arbitrary: empty, weight: 2 },
        { arbitrary: single, weight: 5 },
      );
    }
    const multi = fc
      .subarray(pool, { minLength: 2, maxLength: Math.min(maxShards, pool.length) })
      .chain((ids) =>
        fc
          .array(fc.float({ min: 0, max: 1e6, noNaN: true }), {
            minLength: ids.length,
            maxLength: ids.length,
          })
          .map((vals) => {
            /** @type {Record<string, number>} */
            const out = {};
            for (let i = 0; i < ids.length; i++) out[ids[i]] = Math.abs(vals[i]);
            return out;
          }),
      );
    return fc.oneof(
      { arbitrary: empty, weight: 2 },
      { arbitrary: single, weight: 3 },
      { arbitrary: multi, weight: 3 },
    );
  }

  const single = fc
    .tuple(deviceIds, fc.float({ min: 0, max: 1e6, noNaN: true }))
    .map(([id, n]) => ({ [id]: Math.abs(n) }));
  const multi = fc
    .uniqueArray(deviceIds, { minLength: 2, maxLength: maxShards })
    .chain((ids) =>
      fc
        .array(fc.float({ min: 0, max: 1e6, noNaN: true }), {
          minLength: ids.length,
          maxLength: ids.length,
        })
        .map((vals) => {
          /** @type {Record<string, number>} */
          const out = {};
          for (let i = 0; i < ids.length; i++) {
            out[ids[i]] = Math.abs(vals[i]);
          }
          return out;
        }),
    );
  return fc.oneof(
    { arbitrary: empty, weight: 2 },
    { arbitrary: single, weight: 3 },
    { arbitrary: multi, weight: 3 },
  );
}

/**
 * One ConceptMastery with G-Counter shards + LWW lastExercisedAt.
 *
 * @param {{ conceptId?: fc.Arbitrary<string>, deviceIds?: fc.Arbitrary<string>, devicePool?: string[] }} [opts]
 */
export function conceptMasteryArb(opts = {}) {
  const conceptId = opts.conceptId ?? conceptIdArb;
  const devicePool = opts.devicePool;
  const deviceIds = opts.deviceIds ?? deviceIdArb;
  const shardOpts = devicePool ? { devicePool } : { deviceIds };
  const hlcDevice = devicePool ? fc.constantFrom(...devicePool) : deviceIds;
  return fc.record({
    conceptId,
    alpha: gCounterShardsArb(shardOpts),
    beta: gCounterShardsArb(shardOpts),
    lastExercisedAt: hlcArb({ deviceId: hlcDevice }),
  });
}

const OUTCOMES = /** @type {const} */ ([
  "correct",
  "partial",
  "incorrect",
  "ungraded",
]);

/**
 * Single FrictionSample. `capturedAt` defaults to a free HLC; callers can
 * force collisions via {@link frictionSampleSetArb}.
 *
 * @param {{ capturedAt?: fc.Arbitrary<string>, conceptId?: fc.Arbitrary<string> }} [opts]
 */
export function frictionSampleArb(opts = {}) {
  const conceptId = opts.conceptId ?? conceptIdArb;
  const capturedAt = opts.capturedAt ?? hlcArb();
  return fc.record({
    conceptId,
    hesitationMs: fc.integer({ min: 0, max: 600_000 }),
    inputVelocity: fc.float({ min: 0, max: 500, noNaN: true }).map(Math.abs),
    revisionCount: fc.integer({ min: 0, max: 10_000 }),
    assistanceRequested: fc.boolean(),
    outcome: fc.constantFrom(...OUTCOMES),
    capturedAt,
  });
}

/**
 * Friction G-Set generator with first-class collision bias.
 *
 * @param {{ maxSamples?: number, collisionBias?: boolean, conceptId?: fc.Arbitrary<string> }} [opts]
 */
export function frictionSampleSetArb(opts = {}) {
  const maxSamples = opts.maxSamples ?? MAX_FRICTION_SAMPLES;
  const collisionBias = opts.collisionBias !== false;
  const conceptId = opts.conceptId;
  const sampleOpts = conceptId ? { conceptId } : {};

  const empty = fc.constant([]);
  const unique = fc
    .integer({ min: 1, max: maxSamples })
    .chain((n) =>
      fc
        .tuple(
          fc.array(
            frictionSampleArb({
              ...sampleOpts,
              capturedAt: fc.constant(encodeHLC(0, 0, "edge-seed")),
            }),
            { minLength: n, maxLength: n },
          ),
          fc.uniqueArray(hlcArb(), { minLength: n, maxLength: n }),
        )
        .map(([samples, hlcs]) =>
          samples.map((s, i) => ({ ...s, capturedAt: hlcs[i] })),
        ),
    );

  const colliding = fc
    .integer({ min: 2, max: Math.max(2, Math.min(6, maxSamples)) })
    .chain((n) =>
      fc
        .tuple(
          hlcArb(),
          fc.array(frictionSampleArb(sampleOpts), { minLength: n, maxLength: n }),
        )
        .map(([sharedHlc, samples]) =>
          samples.map((s, i) =>
            i < 2 || i % 2 === 0 ? { ...s, capturedAt: sharedHlc } : s,
          ),
        ),
    );

  if (!collisionBias) {
    return fc.oneof(empty, unique);
  }
  return fc.oneof(
    { arbitrary: empty, weight: 2 },
    { arbitrary: unique, weight: 4 },
    { arbitrary: colliding, weight: 3 },
  );
}

/**
 * Bounded friction log for full CognitiveState (avoids uniqueArray rejection
 * sampling that blows up 10k CI runs). Keys are unique by construction when
 * a deviceId seed is supplied; otherwise uses a stable synthetic device.
 *
 * @param {{ maxSamples?: number, deviceId?: string }} [opts]
 */
export function frictionLogBoundedArb(opts = {}) {
  const maxSamples = opts.maxSamples ?? 6;
  const deviceSeed = opts.deviceId ?? "edge-fric";
  return fc
    .integer({ min: 0, max: maxSamples })
    .chain((n) => {
      if (n === 0) return fc.constant([]);
      return fc
        .array(
          frictionSampleArb({
            capturedAt: fc.constant(encodeHLC(0, 0, "edge-seed")),
          }),
          { minLength: n, maxLength: n },
        )
        .map((samples) =>
          samples.map((s, i) => ({
            ...s,
            // Include device seed so two replicas do not systematically collide.
            capturedAt: encodeHLC(1_000_000 + i, i, `${deviceSeed}`.slice(0, 64)),
          })),
        );
    });
}

/**
 * Profile LWW register under HLC order.
 *
 * @param {{ deviceId?: fc.Arbitrary<string>, updatedAt?: fc.Arbitrary<string> }} [opts]
 */
export function profileArb(opts = {}) {
  const updatedAt = opts.updatedAt ?? hlcArb({ deviceId: opts.deviceId });
  return fc.record({
    ageBand: fc.constantFrom(...AGE_BANDS),
    track: fc.stringMatching(/^[a-z][a-z0-9-]{2,40}$/),
    language: fc.constantFrom("en-IN", "hi-IN", "ta-IN", "en", "hi"),
    updatedAt,
  });
}

/**
 * State-vector map. When `equalTimestampBias` is on, injects two keys that
 * share physical+logical but differ by deviceId (adversarial tie).
 *
 * @param {{
 *   deviceId?: fc.Arbitrary<string>,
 *   equalTimestampBias?: boolean,
 * }} [opts]
 */
export function stateVectorArb(opts = {}) {
  const deviceId = opts.deviceId ?? deviceIdArb;
  const equalTimestampBias = opts.equalTimestampBias !== false;

  const plain = fc
    .tuple(
      fc.constantFrom("session", "profile", "mastery", "mode"),
      hlcArb({ deviceId }),
      fc.option(
        fc.tuple(fc.constantFrom("active", "friction"), hlcArb({ deviceId })),
        { nil: null },
      ),
    )
    .map(([k0, h0, extra]) => {
      /** @type {Record<string, string>} */
      const out = { [k0]: h0, session: h0 };
      if (extra) out[extra[0]] = extra[1];
      return out;
    });

  const adversarial = equalHlcDifferentDevicesArb.map(({ a, b, deviceA, deviceB }) => ({
    session: a,
    profile: b,
    [`device:${deviceA}`]: a,
    [`device:${deviceB}`]: b,
  }));

  if (!equalTimestampBias) return plain;
  return fc.oneof(
    { arbitrary: plain, weight: 3 },
    { arbitrary: adversarial, weight: 2 },
  );
}

/**
 * Mastery map keyed by conceptId. Biased toward empty / single / multi.
 *
 * @param {{
 *   conceptIds?: string[],
 *   deviceIds?: fc.Arbitrary<string>,
 *   devicePool?: string[],
 * }} [opts]
 */
export function masteryMapArb(opts = {}) {
  const devicePool = opts.devicePool;
  const deviceIds = opts.deviceIds ?? deviceIdArb;
  const masteryOpts = devicePool ? { devicePool } : { deviceIds };

  if (opts.conceptIds) {
    const ids = opts.conceptIds;
    if (ids.length === 0) return fc.constant({});
    return fc
      .array(conceptMasteryArb(masteryOpts), {
        minLength: ids.length,
        maxLength: ids.length,
      })
      .map((rows) => {
        /** @type {Record<string, object>} */
        const out = {};
        for (let i = 0; i < ids.length; i++) {
          out[ids[i]] = { ...rows[i], conceptId: ids[i] };
        }
        return out;
      });
  }

  return fc.oneof(
    { arbitrary: fc.constant({}), weight: 2 },
    {
      arbitrary: conceptIdArb.chain((id) =>
        conceptMasteryArb({ ...masteryOpts, conceptId: fc.constant(id) }).map((m) => ({
          [id]: m,
        })),
      ),
      weight: 3,
    },
    {
      arbitrary: fc
        .uniqueArray(conceptIdArb, { minLength: 2, maxLength: MAX_CONCEPTS })
        .chain((ids) => masteryMapArb({ conceptIds: ids, ...masteryOpts })),
      weight: 3,
    },
  );
}

/**
 * Full CognitiveState. Always Zod-valid. Options:
 *   - `subjectId` — fix the subject (replica pairs share one)
 *   - `devicePool` — fix contributing devices
 *   - `conceptIds` — fix mastery keys (for overlap control)
 *   - `equalTimestampBias` — adversarial equal-HLC state vectors
 *   - `emptyBias` — weight empty mastery+friction higher
 *
 * @param {{
 *   subjectId?: fc.Arbitrary<string> | string,
 *   devicePool?: string[],
 *   conceptIds?: string[],
 *   equalTimestampBias?: boolean,
 *   emptyBias?: boolean,
 * }} [opts]
 */
export function cognitiveStateArb(opts = {}) {
  const equalTimestampBias = opts.equalTimestampBias !== false;
  const emptyBias = opts.emptyBias !== false;

  const subjectIdArbResolved =
    typeof opts.subjectId === "string"
      ? fc.constant(opts.subjectId)
      : (opts.subjectId ?? subjectIdArb);

  const devicesArb = opts.devicePool
    ? fc.constant(opts.devicePool)
    : fc.uniqueArray(deviceIdArb, { minLength: 1, maxLength: MAX_SHARDS });

  return fc
    .tuple(subjectIdArbResolved, devicesArb)
    .chain(([subjectId, devicePool]) => {
      const deviceId = fc.constantFrom(...devicePool);
      const mastery =
        opts.conceptIds !== undefined
          ? masteryMapArb({ conceptIds: opts.conceptIds, devicePool })
          : emptyBias
            ? fc.oneof(
                { arbitrary: fc.constant({}), weight: 2 },
                { arbitrary: masteryMapArb({ devicePool }), weight: 5 },
              )
            : masteryMapArb({ devicePool });

      const frictionDevice = devicePool[0] ?? "edge-fric";
      const friction = frictionLogBoundedArb({
        maxSamples: 6,
        deviceId: frictionDevice,
      });

      return fc
        .record({
          mastery,
          frictionLog: friction,
          profile: profileArb({ deviceId }),
          stateVector: stateVectorArb({ deviceId, equalTimestampBias }),
          activeConceptId: fc.option(conceptIdArb, { nil: null }),
          mode: fc.constantFrom(...GUIDANCE_MODES),
        })
        .map((body) => ({
          protocolVersion: PROTOCOL_VERSION,
          subjectId,
          deviceIds: [...devicePool],
          activeConceptId: body.activeConceptId,
          mode: body.mode,
          mastery: body.mastery,
          frictionLog: body.frictionLog,
          profile: body.profile,
          stateVector: body.stateVector,
        }));
    });
}

/**
 * Pair of CognitiveState replicas for the same subjectId with tunable
 * mastery-key overlap and optional equal-timestamp injection across replicas.
 *
 * Overlap modes:
 *   - `"none"`    — disjoint concept keys (and often disjoint devices)
 *   - `"partial"` — shared + private concepts
 *   - `"full"`    — identical concept key sets
 *
 * @param {{
 *   overlap?: "none" | "partial" | "full",
 *   equalTimestampBias?: boolean,
 * }} [opts]
 */
export function replicaPairArb(opts = {}) {
  const overlap = opts.overlap ?? "partial";
  const equalTimestampBias = opts.equalTimestampBias !== false;

  return fc
    .tuple(
      subjectIdArb,
      fc.uniqueArray(deviceIdArb, { minLength: 2, maxLength: MAX_SHARDS }),
      fc.uniqueArray(conceptIdArb, { minLength: 2, maxLength: MAX_CONCEPTS }),
      equalHlcDifferentDevicesArb,
    )
    .chain(([subjectId, devices, concepts, equalPair]) => {
      const mid = Math.max(1, Math.floor(devices.length / 2));
      const leftDevices = overlap === "none" ? devices.slice(0, mid) : devices;
      const rightDevices = overlap === "none" ? devices.slice(mid) : devices;
      const leftPool = leftDevices.length ? leftDevices : [devices[0]];
      const rightPool = rightDevices.length
        ? rightDevices
        : [devices[devices.length - 1]];

      /** @type {string[]} */
      let leftConcepts;
      /** @type {string[]} */
      let rightConcepts;
      if (overlap === "none") {
        const cut = Math.max(1, Math.floor(concepts.length / 2));
        leftConcepts = concepts.slice(0, cut);
        rightConcepts = concepts.slice(cut);
      } else if (overlap === "full") {
        leftConcepts = concepts;
        rightConcepts = concepts;
      } else {
        const shared = concepts.slice(0, Math.max(1, Math.floor(concepts.length / 2)));
        leftConcepts = concepts.slice(0, Math.max(shared.length, concepts.length - 1));
        rightConcepts = [
          ...shared,
          ...concepts.slice(shared.length).filter((_, i) => i % 2 === 0),
        ];
      }

      const leftBase = cognitiveStateArb({
        subjectId,
        devicePool: leftPool,
        conceptIds: leftConcepts,
        equalTimestampBias: false,
        emptyBias: false,
      });
      const rightBase = cognitiveStateArb({
        subjectId,
        devicePool: rightPool,
        conceptIds: rightConcepts,
        equalTimestampBias: false,
        emptyBias: false,
      });

      return fc.tuple(leftBase, rightBase).map(([left, right]) => {
        let leftOut = left;
        let rightOut = right;
        if (equalTimestampBias) {
          leftOut = {
            ...left,
            stateVector: { ...left.stateVector, session: equalPair.a },
            profile: { ...left.profile, updatedAt: equalPair.a },
          };
          rightOut = {
            ...right,
            stateVector: { ...right.stateVector, session: equalPair.b },
            profile: { ...right.profile, updatedAt: equalPair.b },
          };
        }
        return { left: leftOut, right: rightOut, overlap, subjectId };
      });
    });
}

/**
 * Assert `arb` values always satisfy `schema` for `numRuns` CI-seeded cases.
 * Emits a single structured outcome event (bounded observability).
 *
 * @param {string} name
 * @param {fc.Arbitrary<unknown>} arb
 * @param {{ safeParse: (v: unknown) => { success: boolean, error?: unknown } }} schema
 * @param {{ numRuns?: number, seed?: number }} [opts]
 */
export function assertArbitraryMatchesSchema(name, arb, schema, opts = {}) {
  const numRuns = opts.numRuns ?? CI_NUM_RUNS;
  const seed = opts.seed ?? CI_ARBITRARY_SEED;
  try {
    fc.assert(
      fc.property(arb, (value) => {
        const parsed = schema.safeParse(value);
        if (!parsed.success) {
          throw new Error(
            `ARBITRARY_SCHEMA_VIOLATION:${name}:${JSON.stringify(parsed.error)}`,
          );
        }
        return true;
      }),
      { numRuns, seed, verbose: false },
    );
    emitArbitraryEvent({
      kind: name,
      outcome: "ok",
      numRuns,
      seed,
    });
  } catch (err) {
    emitArbitraryEvent({
      kind: name,
      outcome: "error",
      code: "ARBITRARY_SCHEMA_VIOLATION",
      numRuns,
      seed,
      message: err instanceof Error ? err.message.slice(0, 500) : String(err),
    });
    throw err;
  }
}

export {
  fc,
  PROTOCOL_VERSION,
  hlcSchema,
  frictionSampleSchema,
  conceptMasterySchema,
  cognitiveStateSchema,
};
