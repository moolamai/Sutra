/**
 * Stubbed-down dependency test vectors (surface × forced failure → mode/signal).
 * Run: pnpm --filter @moolam/sync-protocol build && node --test tests/degradation_stub_vectors.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEGRADATION_MODES,
  DEGRADATION_OPERATIONS,
  DEGRADATION_SURFACES,
} from "../../contracts/dist/index.js";
import {
  assertStaleReadPayload,
  claimStubVectorIdempotencyKey,
  createDegradationRegistry,
  degradationStubVectorCatalogSchema,
  evaluateDegradationStubVector,
} from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = join(__dirname, "..");
const FIXTURE_DIR = join(PKG, "fixtures", "degradation-registry");
const MANIFEST = JSON.parse(
  readFileSync(join(FIXTURE_DIR, "manifest.json"), "utf8"),
);
const CATALOG = JSON.parse(
  readFileSync(join(FIXTURE_DIR, MANIFEST.stubVectorsFile), "utf8"),
);

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

test("happy path: stub vector catalog validates; schema committed", () => {
  assert.ok(
    existsSync(join(PKG, "schemas", "DegradationStubVectorCatalog.json")),
  );
  const parsed = degradationStubVectorCatalogSchema.parse(CATALOG);
  assert.ok(parsed.vectors.length >= 6);
  assert.equal(new Set(parsed.vectors.map((v) => v.id)).size, parsed.vectors.length);
});

test("happy path: every default binding has a stub vector; evaluate matches registry", () => {
  const registry = createDegradationRegistry();
  const covered = new Set();

  for (const vector of CATALOG.vectors) {
    const result = evaluateDegradationStubVector(vector, registry);
    assert.equal(result.ok, true, `${vector.id}: ${result.failureClass}`);
    assert.equal(result.mode, vector.expectedMode);
    assert.equal(result.signalCode, vector.expectedSignalCode);
    assert.equal(result.subjectId, "anika-k");
    covered.add(`${vector.surface}:${vector.operation}`);
    emit({
      event: "degradation.stub",
      outcome: "ok",
      subjectId: result.subjectId,
      deviceId: result.deviceId,
      surface: result.surface,
      operation: result.operation,
      mode: result.mode,
      signalCode: result.signalCode,
      forcedFailureKind: result.forcedFailureKind,
    });
  }

  for (const surface of DEGRADATION_SURFACES) {
    for (const operation of DEGRADATION_OPERATIONS) {
      assert.ok(
        covered.has(`${surface}:${operation}`),
        `missing stub vector for ${surface}/${operation}`,
      );
    }
  }

  for (const mode of DEGRADATION_MODES) {
    assert.ok(
      CATALOG.vectors.some((v) => v.expectedMode === mode),
      `no vector for mode ${mode}`,
    );
  }
});

test("edge: violation fixtures reject (empty subject, fabrication, silent retry)", () => {
  const registry = createDegradationRegistry();
  for (const violation of CATALOG.violations) {
    if (violation.kind === "missing_subject") {
      const result = evaluateDegradationStubVector(violation.vector, registry);
      assert.equal(result.ok, false);
      assert.equal(result.failureClass, "missing_subject");
    } else if (violation.kind === "fabrication_forbidden") {
      const denied = assertStaleReadPayload(violation.payload, {
        subjectId: violation.subjectId,
      });
      assert.equal(denied.ok, false);
      assert.equal(denied.failureClass, "fabrication_forbidden");
    } else if (violation.kind === "schema_violation") {
      const result = evaluateDegradationStubVector(violation.raw, registry);
      assert.equal(result.ok, false);
      assert.equal(result.failureClass, "schema_violation");
    } else {
      assert.fail(`unknown violation kind ${violation.kind}`);
    }
  }
});

test("edge: idempotent replay does not double-apply; concurrent subjects stay isolated", () => {
  const seen = new Set();
  const vector = CATALOG.vectors.find(
    (v) => v.id === "storage-write-unavailable-hard-stop",
  );
  const first = claimStubVectorIdempotencyKey(seen, vector.idempotencyKey);
  const replay = claimStubVectorIdempotencyKey(seen, vector.idempotencyKey);
  assert.equal(first.first, true);
  assert.equal(replay.first, false);

  const other = {
    ...vector,
    subjectId: "brian-m",
    idempotencyKey: "brian-m:storage:write:dep-down-1",
  };
  const otherClaim = claimStubVectorIdempotencyKey(seen, other.idempotencyKey);
  assert.equal(otherClaim.first, true);

  const a = evaluateDegradationStubVector(vector);
  const b = evaluateDegradationStubVector(other);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.subjectId, "anika-k");
  assert.equal(b.subjectId, "brian-m");
  assert.notEqual(a.subjectId, b.subjectId);
});

test("observability: evaluate outcomes never embed learner content keys", () => {
  const result = evaluateDegradationStubVector(CATALOG.vectors[0]);
  assert.equal(result.ok, true);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /utterance|prompt|arguments|fabricated/i);
  assert.match(serialized, /DEGRADE_/);
});
