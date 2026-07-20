/**
 * Pack-oracle registration tests (C3 critic-interface).
 * Run: pnpm --filter @moolam/learning test
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  TRAJECTORY_SCHEMA_VERSION,
  CriticContractError,
  CriticRegistry,
  REFERENCE_PACK_ORACLE_MANIFESTS,
  createPackOracleCritic,
  isRewardHackFixture,
  loadPackOracleManifest,
  parsePackOracleManifest,
  registerPackOraclesFromManifest,
  registerReferencePackOracles,
} from "../dist/index.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

function draft(overrides = {}) {
  return {
    schemaVersion: TRAJECTORY_SCHEMA_VERSION,
    subjectId: "subj.oracle.test",
    sessionId: "sess-1",
    turnId: "turn-1",
    deviceId: "dev-oracle-01",
    capturedAt: "2026-07-16T12:00:00.000Z",
    locality: "on-device",
    consent: {
      optedIn: true,
      consentClass: "research",
      recordedAt: "2026-07-16T12:00:00.000Z",
    },
    stages: [{ stage: "act", opCode: "tool.write", status: "ok" }],
    ...overrides,
  };
}

test("happy path: load two reference pack oracles and score", () => {
  const events = [];
  const registry = new CriticRegistry();
  const results = registerReferencePackOracles(registry, {
    repoRoot: REPO_ROOT,
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(results.length, 2);
  assert.equal(REFERENCE_PACK_ORACLE_MANIFESTS.length, 2);
  assert.equal(registry.list().length, 2);

  const mastery = registry.require("oracle.teacher.mastery-math", "1.0.0");
  const citation = registry.require(
    "oracle.teacher.citation-resolution",
    "1.0.0",
  );

  const masteryScore = mastery.score(draft());
  assert.ok(masteryScore.total > 0);
  assert.equal(masteryScore.rubricVersion, "1.0.0");

  const citeScore = citation.score(
    draft({
      stages: [{ stage: "retrieve", opCode: "knowledge.cite", status: "ok" }],
    }),
  );
  assert.ok(citeScore.total > 0);

  assert.ok(
    events.some((e) => e.event === "learning.critic.pack_oracle.load"),
  );
  assert.ok(
    events.some((e) => e.event === "learning.critic.pack_oracle.register"),
  );
});

test("edge: empty / tool-spam reward-hack fixtures score zero on pack oracles", () => {
  const registry = new CriticRegistry();
  registerReferencePackOracles(registry, { repoRoot: REPO_ROOT });
  const mastery = registry.require("oracle.teacher.mastery-math", "1.0.0");
  const empty = draft({ stages: [] });
  assert.equal(isRewardHackFixture(empty), true);
  assert.equal(mastery.score(empty).total, 0);

  const spam = draft({
    toolCallIds: Array.from({ length: 10 }, (_, i) => `t${i}`),
    stages: [{ stage: "act", status: "error" }],
  });
  assert.equal(mastery.score(spam).total, 0);
});

test("edge: invalid manifest throws typed invalid_manifest", () => {
  assert.throws(
    () =>
      parsePackOracleManifest({
        schemaVersion: "wrong",
        packId: "x",
        oracles: [],
      }),
    (err) =>
      err instanceof CriticContractError &&
      err.obligation === "critic.invalid_manifest",
  );
});

test("edge: missing subjectId on pack oracle throws subject_scope", () => {
  const critic = createPackOracleCritic({
    rubricId: "oracle.test",
    rubricVersion: "1.0.0",
    oracleKind: "mastery",
    weights: { mastery_signal: 0.5 },
  });
  assert.throws(
    () => critic.score(draft({ subjectId: "" })),
    (err) =>
      err instanceof CriticContractError &&
      err.obligation === "critic.subject_scope",
  );
});

test("idempotent: reloading same manifest does not double-register conflict when same instance path", () => {
  const registry = new CriticRegistry();
  const first = registerPackOraclesFromManifest(
    registry,
    REFERENCE_PACK_ORACLE_MANIFESTS[0],
    { repoRoot: REPO_ROOT },
  );
  assert.equal(first.critics.length, 1);
  // Second load of a *different* critic identity with same key must refuse.
  const entry = loadPackOracleManifest(REFERENCE_PACK_ORACLE_MANIFESTS[0], {
    repoRoot: REPO_ROOT,
  });
  const other = createPackOracleCritic(entry.oracles[0], {
    packId: entry.packId,
  });
  assert.throws(
    () =>
      registry.register(other, {
        packId: entry.packId,
        oracleKind: entry.oracles[0].oracleKind,
      }),
    (err) =>
      err instanceof CriticContractError &&
      err.obligation === "critic.invalid_rubric",
  );
});

test("sovereignty: pack oracle telemetry has subjectId/deviceId and no utterance bodies", () => {
  const events = [];
  const registry = new CriticRegistry();
  registerReferencePackOracles(registry, {
    repoRoot: REPO_ROOT,
    onTelemetry: (e) => events.push(e),
  });
  registry
    .require("oracle.teacher.mastery-math", "1.0.0")
    .score(draft());
  const blob = JSON.stringify(events);
  assert.equal(/utterance|keystrokeText|rawContent/i.test(blob), false);
  assert.ok(
    events
      .filter((e) => e.event === "learning.critic.score")
      .every((e) => e.subjectId && e.deviceId),
  );
});
