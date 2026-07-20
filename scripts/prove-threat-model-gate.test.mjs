/**
 * Unit + integration coverage for the threat-model red→green proof.
 * Run: node --test scripts/prove-threat-model-gate.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { THREAT_MODEL } from "./check-threat-model-inventory.mjs";
import {
  SEED_BROKEN_LINK,
  SEED_MARKER,
  SEED_THREAT_ID,
  proveThreatModelGate,
  seedBrokenTestLink,
  seedMissingTestLink,
} from "./prove-threat-model-gate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CI_WORKFLOW = path.join(REPO_ROOT, ".github", "workflows", "ci.yml");

const SAMPLE_ROW =
  "| `TH-EDGE-001` | `TB-EDGE-02` | S | threat | mitigation | `packages/cognitive-core/tests/plan_stage_integration.test.mjs` | mitigated |";
const SAMPLE_BODY = ["## STRIDE enumeration", SAMPLE_ROW, "## Correlation"].join(
  "\n",
);

test("seedBrokenTestLink swaps only the targeted row's link", () => {
  const seeded = seedBrokenTestLink(SAMPLE_BODY);
  assert.ok(seeded.includes(SEED_BROKEN_LINK));
  assert.ok(seeded.includes(SEED_MARKER));
  assert.ok(!seeded.includes("plan_stage_integration.test.mjs"));
  // Everything outside the row is untouched.
  assert.ok(seeded.startsWith("## STRIDE enumeration"));
  assert.ok(seeded.endsWith("## Correlation"));
});

test("seedMissingTestLink leaves a prose-only mitigation", () => {
  const seeded = seedMissingTestLink(SAMPLE_BODY);
  assert.ok(!/`(?:packages|scripts)\/[^`]+\.test\.mjs`/.test(seeded));
  assert.ok(seeded.includes("prose-only mitigation"));
  assert.ok(seeded.includes(SEED_MARKER));
});

test("edge: double-seed refused with typed error", () => {
  const once = seedBrokenTestLink(SAMPLE_BODY);
  assert.throws(
    () => seedBrokenTestLink(once),
    /THREAT_MODEL_PROVE_ALREADY_SEEDED/,
  );
  assert.throws(
    () => seedMissingTestLink(once),
    /THREAT_MODEL_PROVE_ALREADY_SEEDED/,
  );
});

test("edge: seeding an unknown threat row fails loudly, not silently", () => {
  assert.throws(
    () => seedBrokenTestLink("## STRIDE enumeration\nno rows here"),
    /THREAT_MODEL_PROVE_SEED_FAILED/,
  );
});

test("edge: red without the offender named fails the prove (and restores)", () => {
  const before = readFileSync(THREAT_MODEL, "utf8");
  let strideCalls = 0;
  const result = proveThreatModelGate({
    runInventory: () => ({ status: 0, combined: "ok" }),
    runStride: () => {
      strideCalls += 1;
      // baseline green, then red with an empty log (forces failure), rest green
      if (strideCalls === 2) return { status: 1, combined: "failed silently" };
      return { status: 0, combined: "ok" };
    },
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.failures.some((f) => f.includes("SEEDED_BROKEN_LINK_NO_DIFF")),
  );
  assert.equal(
    readFileSync(THREAT_MODEL, "utf8"),
    before,
    "THREAT-MODEL.md must be restored byte-identical",
  );
});

test("edge: gate staying green on a seeded violation fails the prove", () => {
  const before = readFileSync(THREAT_MODEL, "utf8");
  const result = proveThreatModelGate({
    runInventory: () => ({ status: 0, combined: "ok" }),
    runStride: () => ({ status: 0, combined: "ok" }),
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.failures.some((f) =>
      f.includes("SEEDED_BROKEN_LINK_DID_NOT_FAIL"),
    ),
  );
  assert.ok(
    result.failures.some((f) =>
      f.includes("SEEDED_MISSING_LINK_DID_NOT_FAIL"),
    ),
  );
  assert.equal(readFileSync(THREAT_MODEL, "utf8"), before);
});

test("ci wires the threat-model job (gates + prove + unit tests)", () => {
  const ci = readFileSync(CI_WORKFLOW, "utf8");
  assert.match(ci, /check-threat-model-inventory\.mjs|threat-model:inventory:check/);
  assert.match(ci, /check-threat-model-stride\.mjs|threat-model:stride:check/);
  assert.match(ci, /prove-threat-model-gate\.mjs/);
  assert.match(ci, /prove-threat-model-gate\.test\.mjs/);
});

test("happy path: live prove — broken link red, prose-only red, reverts green", () => {
  const before = readFileSync(THREAT_MODEL, "utf8");
  const result = proveThreatModelGate();
  assert.equal(result.ok, true, result.failures.join("\n\n"));
  for (const name of [
    "baseline",
    "broken-link-red",
    "revert-broken-green",
    "missing-link-red",
    "reverted-green",
  ]) {
    assert.ok(
      result.phases.some((p) => p.phase === name && p.outcome === "ok"),
      `phase ${name} must pass`,
    );
  }
  // Failing output names the offending threat and the unresolved path.
  assert.match(result.brokenLog ?? "", new RegExp(SEED_THREAT_ID));
  assert.ok((result.brokenLog ?? "").includes(SEED_BROKEN_LINK));
  assert.match(result.missingLog ?? "", /missing_test_link/);
  // Sovereignty: restored model still scopes every boundary by subjectId.
  const after = readFileSync(THREAT_MODEL, "utf8");
  assert.equal(after, before, "prove must leave the tree byte-identical");
  assert.ok(after.includes("subjectId"));
});
