/**
 * Unit tests for the parser chunk-boundary fuzz CI gate prove helpers.
 * Run: node --test scripts/prove-parser-chunk-fuzz-gate.test.mjs
 *
 * Full green→red→green path is exercised by `pnpm golden:fuzz:prove` in CI.
 * Nested `node --test` under another test runner is avoided here — Windows
 * child status can be unreliable; injectDrift is asserted via the package API.
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  SEED_ENV,
  SEED_MARKER,
  ensureBuilt,
  runChunkFuzz,
} from "./prove-parser-chunk-fuzz-gate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

function log(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "parser.chunk_fuzz.prove.test", ...event })}\n`,
  );
}

test("happy path: baseline fuzz (no seed) is green", () => {
  ensureBuilt();
  const result = runChunkFuzz({ [SEED_ENV]: "0" });
  assert.equal(result.status, 0, result.combined.slice(0, 2000));
  log({
    outcome: "ok",
    phase: "baseline",
    subjectId: "anika-k",
    deviceId: "ci-gate",
  });
});

test("edge: injectDrift turns corpus red with unified diff (API)", async () => {
  ensureBuilt();
  const dist = pathToFileURL(
    path.join(REPO_ROOT, "packages/runtime-harness/dist/index.js"),
  ).href;
  const {
    loadGoldenTurnCorpus,
    runChunkBoundaryFuzz,
    unifiedDiff,
  } = await import(dist);

  const loaded = loadGoldenTurnCorpus();
  assert.equal(loaded.ok, true);
  const result = runChunkBoundaryFuzz(loaded.fixtures[0], {
    injectDrift: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, "chunk_boundary_drift");
  assert.match(result.diff, /--- fuzz\//);
  assert.match(result.diff, /\+\+\+ fuzz\//);
  assert.match(result.diff, /@@ /);
  assert.match(result.diff, new RegExp(SEED_MARKER));
  assert.match(result.detail, /CHUNK_BOUNDARY_FUZZ_DRIFT/);

  // Contract surface the CI prove asserts on stdout.
  const sample = unifiedDiff('{"a":1}\n', `{"a":"${SEED_MARKER}"}\n`, {
    fromFile: "fuzz/thought-answer-basic.single-chunk.json",
    toFile: "fuzz/thought-answer-basic.split.json",
  });
  assert.match(sample, /--- fuzz\/thought-answer-basic\.single-chunk\.json/);
  assert.match(sample, /\+\+\+ fuzz\/thought-answer-basic\.split\.json/);

  log({
    outcome: "ok",
    phase: "seeded-red-api",
    subjectId: "anika-k",
    deviceId: "ci-gate",
    seedEnv: SEED_ENV,
    turnId: result.turnId,
  });
});

test("edge: seed env constant matches injectDrift marker", () => {
  assert.equal(SEED_ENV, "PARSER_CHUNK_FUZZ_SEED_DRIFT");
  assert.equal(SEED_MARKER, "PARSER_CHUNK_FUZZ_SEED_DRIFT");
  log({
    outcome: "ok",
    phase: "seed-constants",
    subjectId: "anika-k",
    deviceId: "ci-gate",
  });
});
