/**
 * Regenerate golden-join expectedJoin fields from the TS CrdtHarnessResolver.
 *
 * Invariant: never auto-commits. Human review required before checking in
 * changes under fixtures/golden-joins/.
 *
 * Usage (from packages/sync-protocol):
 *   pnpm run build && node scripts/generate-golden-joins.mjs
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CrdtHarnessResolver } from "../dist/crdt_harness_resolver.js";
import { canonicalizeState, sortKeysDeep, applyCompactionHandshake } from "../tests/merge_canon.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "../fixtures/golden-joins");

function hlc(physical, logical, deviceId) {
  return `${String(physical).padStart(15, "0")}:${String(logical).padStart(6, "0")}:${deviceId}`;
}

function base(subjectId, deviceIds, overrides = {}) {
  const device = deviceIds[0];
  return {
    protocolVersion: "1.0.0",
    subjectId,
    deviceIds: [...deviceIds],
    activeConceptId: null,
    mode: "exploratory",
    mastery: {},
    frictionLog: [],
    profile: {
      ageBand: "adult",
      track: "algebra",
      language: "en",
      updatedAt: hlc(1_000_000, 0, device),
    },
    stateVector: { session: hlc(1_000_000, 0, device) },
    ...overrides,
  };
}

function sample(conceptId, capturedAt, extra = {}) {
  return {
    conceptId,
    hesitationMs: 0,
    inputVelocity: 0,
    revisionCount: 0,
    assistanceRequested: false,
    outcome: "correct",
    capturedAt,
    ...extra,
  };
}

function mastery(conceptId, alpha, beta, lastExercisedAt) {
  return { conceptId, alpha, beta, lastExercisedAt };
}

/** Hand-picked inputs — expectedJoin filled by the TS resolver below. */
const CASES = [
  {
    id: "01-shard-max-basic",
    kind: "shard-max",
    note: "Pointwise max of overlapping G-Counter shards",
    stateA: base("subj-shard", ["dev-a"], {
      mastery: {
        "math.ratios": mastery(
          "math.ratios",
          { "dev-a": 2 },
          { "dev-a": 1 },
          hlc(1_000_000, 0, "dev-a"),
        ),
      },
    }),
    stateB: base("subj-shard", ["dev-b"], {
      mastery: {
        "math.ratios": mastery(
          "math.ratios",
          { "dev-b": 3, "dev-a": 1 },
          { "dev-b": 2 },
          hlc(1_000_100, 0, "dev-b"),
        ),
      },
      profile: {
        ageBand: "adult",
        track: "algebra",
        language: "en",
        updatedAt: hlc(1_000_100, 0, "dev-b"),
      },
      stateVector: { session: hlc(1_000_100, 0, "dev-b") },
    }),
  },
  {
    id: "02-shard-max-empty-vs-single",
    kind: "shard-max",
    note: "Empty mastery joins with a single-shard concept",
    stateA: base("subj-empty", ["dev-a"]),
    stateB: base("subj-empty", ["dev-b"], {
      mastery: {
        "sci.force": mastery(
          "sci.force",
          { "dev-b": 4 },
          { "dev-b": 1 },
          hlc(1_000_000, 1, "dev-b"),
        ),
      },
    }),
  },
  {
    id: "03-shard-max-disjoint-concepts",
    kind: "shard-max",
    note: "Disjoint concept keys — union without overlap",
    stateA: base("subj-disjoint", ["dev-a"], {
      mastery: {
        "math.a": mastery("math.a", { "dev-a": 1 }, { "dev-a": 1 }, hlc(1, 0, "dev-a")),
      },
    }),
    stateB: base("subj-disjoint", ["dev-b"], {
      mastery: {
        "math.b": mastery("math.b", { "dev-b": 2 }, { "dev-b": 1 }, hlc(2, 0, "dev-b")),
      },
    }),
  },
  {
    id: "04-shard-max-tostring-key",
    kind: "shard-max",
    note: "Shard id toString must merge by value, not prototype lookup",
    stateA: base("subj-tostring", ["dev-a", "toString"], {
      mastery: {
        "a.0": mastery(
          "a.0",
          { toString: 1, "dev-a": 2 },
          { "dev-a": 1 },
          hlc(1, 0, "dev-a"),
        ),
      },
    }),
    stateB: base("subj-tostring", ["toString"], {
      mastery: {
        "a.0": mastery(
          "a.0",
          { toString: 5 },
          { toString: 1 },
          hlc(2, 0, "toString"),
        ),
      },
    }),
  },
  {
    id: "05-friction-union-disjoint",
    kind: "friction-union",
    note: "G-Set union of two distinct capturedAt keys",
    stateA: base("subj-fric", ["dev-a"], {
      frictionLog: [sample("c.a", hlc(1_000_000, 0, "dev-a"))],
    }),
    stateB: base("subj-fric", ["dev-b"], {
      frictionLog: [sample("c.b", hlc(1_000_001, 0, "dev-b"), { hesitationMs: 10 })],
    }),
  },
  {
    id: "06-friction-union-identical-replay",
    kind: "friction-union",
    note: "Idempotent replay — duplicate identical sample drops once",
    stateA: base("subj-replay", ["dev-a"], {
      frictionLog: [sample("c.a", hlc(1_000_000, 0, "dev-a"), { hesitationMs: 3 })],
    }),
    stateB: base("subj-replay", ["dev-a"], {
      frictionLog: [sample("c.a", hlc(1_000_000, 0, "dev-a"), { hesitationMs: 3 })],
    }),
  },
  {
    id: "07-friction-collision-prefer",
    kind: "friction-collision",
    note: "Same capturedAt, distinct payloads — lexicographic prefer (order-independent)",
    stateA: base("subj-collide", ["dev-a", "dev-b"], {
      frictionLog: [
        sample("a00", hlc(1_000_000, 0, "edge-fric"), {
          hesitationMs: 0,
          outcome: "correct",
        }),
      ],
    }),
    stateB: base("subj-collide", ["dev-a", "dev-b"], {
      frictionLog: [
        sample("v-ref", hlc(1_000_000, 0, "edge-fric"), {
          hesitationMs: 9,
          inputVelocity: 1,
          revisionCount: 1,
          assistanceRequested: true,
          outcome: "incorrect",
        }),
      ],
    }),
  },
  {
    id: "08-friction-empty-logs",
    kind: "friction-union",
    note: "Both friction logs empty",
    stateA: base("subj-fric-empty", ["dev-a"]),
    stateB: base("subj-fric-empty", ["dev-b"]),
  },
  {
    id: "09-lww-equal-physical-logical-session",
    kind: "lww-equal-hlc",
    note: "Equal physical+logical session HLC — deviceId lexicographic tie-break",
    stateA: base("subj-lww", ["dev-a", "dev-b"], {
      mode: "guided",
      activeConceptId: "math.ratios",
      stateVector: {
        session: hlc(1_000_000, 5, "dev-a"),
      },
      profile: {
        ageBand: "adult",
        track: "algebra",
        language: "en",
        updatedAt: hlc(1_000_000, 1, "dev-a"),
      },
    }),
    stateB: base("subj-lww", ["dev-a", "dev-b"], {
      mode: "diagnostic",
      activeConceptId: "math.percents",
      stateVector: {
        session: hlc(1_000_000, 5, "dev-b"),
      },
      profile: {
        ageBand: "adult",
        track: "algebra",
        language: "en",
        updatedAt: hlc(1_000_000, 1, "dev-b"),
      },
    }),
  },
  {
    id: "10-lww-profile-tie-device",
    kind: "lww-equal-hlc",
    note: "Equal physical+logical profile.updatedAt — deviceId chooses winner",
    stateA: base("subj-prof", ["aaa-device", "zzz-device"], {
      profile: {
        ageBand: "child",
        track: "numeracy",
        language: "hi",
        updatedAt: hlc(2_000_000, 0, "aaa-device"),
      },
      stateVector: { session: hlc(1, 0, "aaa-device") },
    }),
    stateB: base("subj-prof", ["aaa-device", "zzz-device"], {
      profile: {
        ageBand: "adult",
        track: "calculus",
        language: "en",
        updatedAt: hlc(2_000_000, 0, "zzz-device"),
      },
      stateVector: { session: hlc(1, 0, "zzz-device") },
    }),
  },
  {
    id: "11-lww-session-strictly-newer",
    kind: "lww-equal-hlc",
    note: "Clear newer session wins mode + activeConceptId",
    stateA: base("subj-new", ["dev-a"], {
      mode: "exploratory",
      activeConceptId: "old.concept",
      stateVector: { session: hlc(100, 0, "dev-a") },
    }),
    stateB: base("subj-new", ["dev-b"], {
      mode: "reinforcement",
      activeConceptId: "new.concept",
      stateVector: { session: hlc(200, 0, "dev-b") },
    }),
  },
  {
    id: "12-lww-last-exercised-at",
    kind: "lww-equal-hlc",
    note: "Mastery lastExercisedAt LWW under HLC order",
    stateA: base("subj-lex", ["dev-a"], {
      mastery: {
        "c.1": mastery("c.1", { "dev-a": 1 }, { "dev-a": 1 }, hlc(50, 0, "dev-a")),
      },
    }),
    stateB: base("subj-lex", ["dev-b"], {
      mastery: {
        "c.1": mastery("c.1", { "dev-b": 1 }, { "dev-b": 1 }, hlc(90, 0, "dev-b")),
      },
    }),
  },
  {
    id: "13-state-vector-pointwise-max",
    kind: "state-vector",
    note: "Pointwise HLC max across overlapping and private keys",
    stateA: base("subj-sv", ["dev-a"], {
      stateVector: {
        session: hlc(10, 0, "dev-a"),
        profile: hlc(20, 0, "dev-a"),
        mastery: hlc(5, 0, "dev-a"),
      },
    }),
    stateB: base("subj-sv", ["dev-b"], {
      stateVector: {
        session: hlc(15, 0, "dev-b"),
        profile: hlc(10, 0, "dev-b"),
        friction: hlc(30, 0, "dev-b"),
      },
    }),
  },
  {
    id: "14-state-vector-equal-hlc-keys",
    kind: "state-vector",
    note: "Adversarial equal physical+logical across stateVector keys",
    stateA: base("subj-sv2", ["dev-a", "dev-b"], {
      stateVector: {
        session: hlc(777, 3, "dev-a"),
        profile: hlc(777, 3, "dev-b"),
        "device:dev-a": hlc(777, 3, "dev-a"),
        "device:dev-b": hlc(777, 3, "dev-b"),
      },
    }),
    stateB: base("subj-sv2", ["dev-a", "dev-b"], {
      stateVector: {
        session: hlc(777, 3, "dev-b"),
        active: hlc(100, 0, "dev-a"),
      },
      mode: "guided",
    }),
  },
  {
    id: "15-state-vector-empty-remote",
    kind: "state-vector",
    note: "Remote empty stateVector does not erase local clocks",
    stateA: base("subj-sv3", ["dev-a"], {
      stateVector: { session: hlc(9, 9, "dev-a"), mode: hlc(9, 9, "dev-a") },
    }),
    stateB: base("subj-sv3", ["dev-b"], {
      stateVector: { session: hlc(1, 0, "dev-b") },
    }),
  },
  {
    id: "16-compaction-announced-timestamps",
    kind: "compaction",
    note: "Join then announce friction timestamps for edge prune handshake",
    stateA: base("subj-compact", ["dev-a"], {
      frictionLog: [
        sample("c.1", hlc(1_000_000, 0, "dev-a")),
        sample("c.2", hlc(1_000_001, 0, "dev-a"), { hesitationMs: 2 }),
      ],
    }),
    stateB: base("subj-compact", ["dev-b"], {
      frictionLog: [sample("c.3", hlc(1_000_002, 0, "dev-b"), { hesitationMs: 4 })],
    }),
  },
  {
    id: "17-compaction-prune-then-merge-idempotent",
    kind: "compaction",
    note: "After prune of announced keys, remereging pruned replica is a no-op",
    stateA: base("subj-compact2", ["dev-a"], {
      frictionLog: [sample("c.1", hlc(2_000_000, 0, "dev-a"))],
    }),
    stateB: base("subj-compact2", ["dev-b"], {
      frictionLog: [sample("c.1", hlc(2_000_000, 0, "dev-a"))],
    }),
  },
  {
    id: "18-idempotent-self-join",
    kind: "idempotent",
    note: "merge(a,a) ≡ a under canonical serialization",
    stateA: base("subj-idemp", ["dev-a"], {
      mode: "guided",
      mastery: {
        "c.x": mastery("c.x", { "dev-a": 7 }, { "dev-a": 2 }, hlc(8, 0, "dev-a")),
      },
      frictionLog: [sample("c.x", hlc(8, 1, "dev-a"))],
    }),
    stateB: null, // filled as clone of stateA during emit
  },
  {
    id: "19-device-ids-union",
    kind: "shard-max",
    note: "deviceIds G-Set union is sorted in the join",
    stateA: base("subj-devs", ["dev-z", "dev-a"]),
    stateB: base("subj-devs", ["dev-m"]),
  },
  {
    id: "20-subject-isolation-refused",
    kind: "subject-isolation",
    note: "Cross-subject merge must refuse — expectedJoin null; expectError SUBJECT_MISMATCH",
    stateA: base("subj-alpha", ["dev-a"]),
    stateB: base("subj-beta", ["dev-b"]),
    expectError: "SUBJECT_MISMATCH",
  },
];

function emitEvent(event) {
  process.stdout.write(`${JSON.stringify({ event: "crdt.golden.generate", ...event })}\n`);
}

function writeCase(entry) {
  const sorted = sortKeysDeep(entry);
  const body = `${JSON.stringify(sorted, null, 2)}\n`;
  const file = path.join(OUT_DIR, `${entry.id}.json`);
  writeFileSync(file, body, "utf8");
  return file;
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const resolver = new CrdtHarnessResolver();
  const manifest = {
    corpus: "golden-joins",
    protocolVersion: "1.0.0",
    note: "Language-neutral (stateA, stateB, expectedJoin) triples. Expected joins are produced by the TS CrdtHarnessResolver and reviewed before commit. Regeneration: pnpm --filter @moolam/sync-protocol exec node scripts/generate-golden-joins.mjs — never auto-commit.",
    cases: [],
  };

  for (const raw of CASES) {
    const stateA = raw.stateA;
    const stateB =
      raw.id === "18-idempotent-self-join" ? structuredClone(stateA) : raw.stateB;

    const entry = {
      id: raw.id,
      kind: raw.kind,
      note: raw.note,
      subjectId: stateA.subjectId,
      stateA,
      stateB,
      expectedJoin: null,
      expectError: raw.expectError ?? null,
      compactedSampleTimestamps: null,
      expectedAfterPruneRemerge: null,
    };

    if (raw.expectError) {
      try {
        resolver.merge(stateA, stateB);
        throw new Error(`expected ${raw.expectError} for ${raw.id}`);
      } catch (err) {
        if (!(err && err.code === raw.expectError)) throw err;
      }
      entry.expectedJoin = null;
    } else {
      const { merged } = resolver.merge(stateA, stateB);
      entry.expectedJoin = merged;
      entry.canonicalJoin = JSON.parse(canonicalizeState(merged));

      if (raw.kind === "compaction") {
        const timestamps = merged.frictionLog.map((s) => s.capturedAt);
        entry.compactedSampleTimestamps = timestamps;
        const pruned = applyCompactionHandshake(stateA, timestamps);
        const again = resolver.merge(merged, pruned).merged;
        entry.expectedAfterPruneRemerge = again;
      }
    }

    writeCase(entry);
    manifest.cases.push({ id: entry.id, kind: entry.kind, file: `${entry.id}.json` });
    emitEvent({
      outcome: "ok",
      id: entry.id,
      kind: entry.kind,
      subjectId: entry.subjectId,
      expectError: entry.expectError,
    });
  }

  writeFileSync(
    path.join(OUT_DIR, "manifest.json"),
    `${JSON.stringify(sortKeysDeep(manifest), null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    path.join(OUT_DIR, "README.md"),
    `# Golden joins corpus

Language-neutral \`(stateA, stateB, expectedJoin)\` triples shared by the
TypeScript and Python CRDT merge suites.

## Invariants

- Plain JSON with canonical (sorted) object keys.
- No language-specific serialization artifacts.
- Updating any golden file requires **human review**.
- \`scripts/generate-golden-joins.mjs\` regenerates \`expectedJoin\` from the
  TS \`CrdtHarnessResolver\` but **never auto-commits**.

## Coverage

| kind | What it proves |
|------|----------------|
| \`shard-max\` | G-Counter pointwise max (incl. \`toString\` shard ids) |
| \`friction-union\` / \`friction-collision\` | G-Set union + deterministic collision prefer |
| \`lww-equal-hlc\` | LWW registers under equal physical+logical HLC ties |
| \`state-vector\` | Pointwise HLC max |
| \`compaction\` | \`compactedSampleTimestamps\` handshake / prune remerge |
| \`idempotent\` | \`merge(a,a) ≡ a\` |
| \`subject-isolation\` | Cross-subject merge refused |

## Load path

Both consumers read the same directory:

\`packages/sync-protocol/fixtures/golden-joins/\`
`,
    "utf8",
  );

  emitEvent({ outcome: "ok", kind: "manifest", count: manifest.cases.length });
}

main();
