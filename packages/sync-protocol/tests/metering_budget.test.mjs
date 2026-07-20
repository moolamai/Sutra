/**
 * Consistency gate for docs/protocol/METERING.md + BudgetHook contract.
 * Run: pnpm --filter @moolam/sync-protocol build && node --test tests/metering_budget.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as contracts from "../../contracts/dist/index.js";
import {
  BUDGET_DECISIONS,
  isBudgetDecision,
} from "../../contracts/dist/index.js";
import {
  invokeBudgetHook,
  meterEventSchema,
  toBudgetMeterTick,
} from "../dist/index.js";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(PKG_ROOT, "..", "..");
const DOC = path.join(REPO_ROOT, "docs", "protocol", "METERING.md");
const PKG_README = path.join(PKG_ROOT, "README.md");
const PROTOCOL_README = path.join(REPO_ROOT, "docs", "protocol", "README.md");
const INTERFACES = path.join(REPO_ROOT, "docs", "sdk", "INTERFACES.md");
const FIXTURE = path.join(PKG_ROOT, "fixtures", "wire-parity", "meter-events.json");

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

test("happy path: metering doc published and linked", async () => {
  const doc = await readFile(DOC, "utf8");
  const pkgReadme = await readFile(PKG_README, "utf8");
  const protocolReadme = await readFile(PROTOCOL_README, "utf8");
  const interfaces = await readFile(INTERFACES, "utf8");

  assert.match(doc, /BudgetHook/);
  assert.match(doc, /allow/);
  assert.match(doc, /throttle/);
  assert.match(doc, /hardStop/);
  assert.match(doc, /MeterEvent/);
  assert.match(pkgReadme, /METERING\.md/);
  assert.match(protocolReadme, /METERING\.md/);
  assert.match(interfaces, /BudgetHook/);
  emit({
    event: "harness.meter.budget",
    outcome: "ok",
    kind: "doc.linked",
    subjectId: null,
  });
});

test("happy path: doc examples match BUDGET_DECISIONS and golden meters", async () => {
  const doc = await readFile(DOC, "utf8");
  const golden = JSON.parse(await readFile(FIXTURE, "utf8"));

  assert.deepEqual([...BUDGET_DECISIONS], ["allow", "throttle", "hardStop"]);
  // Keep sync-protocol helper mirror aligned with @moolam/contracts BudgetHook.
  assert.deepEqual([...BUDGET_DECISIONS], [...contracts.BUDGET_DECISIONS]);
  for (const d of BUDGET_DECISIONS) {
    assert.match(doc, new RegExp(`\`${d}\``), `doc must name ${d}`);
    assert.equal(isBudgetDecision(d), true);
  }
  assert.equal(isBudgetDecision("slow-down"), false);

  // Doc JSON examples cover the primary golden meters (complete + aborted).
  for (const id of ["complete-on-device", "aborted-partial"]) {
    const entry = golden.meters.find((e) => e.id === id);
    assert.ok(entry, id);
    const meter = meterEventSchema.parse(entry.meter);
    assert.match(doc, new RegExp(`"inputTokens": ${meter.inputTokens}`));
    assert.match(doc, new RegExp(`"aborted": ${meter.aborted}`));
  }
  // TS worked examples also exercise the external-api golden shape.
  assert.match(doc, /inputTokens:\s*100/);
  assert.match(doc, /anika-k/);
});

test("edge: invokeBudgetHook allow / throttle / hardStop with subject scope", async () => {
  const meter = meterEventSchema.parse({
    inputTokens: 12,
    outputTokens: 4,
    cachedInputTokens: 2,
    latencyMs: 35,
    modelId: "slm-local",
    locality: "on-device",
    aborted: false,
  });
  const tick = toBudgetMeterTick(meter, {
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
    sessionId: "sess-1",
  });
  assert.equal(tick.subjectId, "anika-k");
  assert.equal(tick.cachedInputTokens, 2);

  const allow = await invokeBudgetHook(
    { onMeterTick: () => "allow" },
    tick,
  );
  assert.equal(allow.outcome, "accepted");
  assert.equal(allow.decision, "allow");
  assert.equal(allow.subjectId, "anika-k");

  const throttle = await invokeBudgetHook(
    { onMeterTick: () => "throttle" },
    tick,
  );
  assert.equal(throttle.decision, "throttle");

  const stop = await invokeBudgetHook(
    { onMeterTick: () => "hardStop" },
    tick,
  );
  assert.equal(stop.decision, "hardStop");

  emit({
    event: "harness.meter.budget",
    outcome: "ok",
    kind: "decision",
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
    decision: stop.decision,
  });
});

test("edge: aborted tick still invokes hook; spend channels stay distinct", async () => {
  const seen = [];
  const hook = {
    onMeterTick(event) {
      seen.push({
        subjectId: event.subjectId,
        inputTokens: event.inputTokens,
        cachedInputTokens: event.cachedInputTokens,
        aborted: event.aborted,
      });
      return event.aborted ? "hardStop" : "allow";
    },
  };
  const aborted = meterEventSchema.parse({
    inputTokens: 8,
    outputTokens: 1,
    cachedInputTokens: 0,
    latencyMs: 12,
    modelId: "slm-local",
    locality: "on-device",
    aborted: true,
  });
  const result = await invokeBudgetHook(
    hook,
    toBudgetMeterTick(aborted, { subjectId: "anika-k", deviceId: "edge-aaaa" }),
  );
  assert.equal(result.outcome, "accepted");
  assert.equal(result.decision, "hardStop");
  assert.equal(result.aborted, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].inputTokens, 8);
  assert.equal(seen[0].cachedInputTokens, 0);
});

test("edge: concurrent-subject race avoided by per-subject counters; replay idempotent", async () => {
  /** @type {Map<string, number>} */
  const spend = new Map();
  /** @type {Set<string>} */
  const seenKeys = new Set();

  const hook = {
    onMeterTick(event) {
      const key = `${event.subjectId}:tick-${event.inputTokens}-${event.outputTokens}-${event.aborted}`;
      if (seenKeys.has(key)) {
        // Idempotent replay — do not double-apply.
        return "allow";
      }
      seenKeys.add(key);
      const prev = spend.get(event.subjectId) ?? 0;
      spend.set(
        event.subjectId,
        prev + event.inputTokens + event.cachedInputTokens,
      );
      return "allow";
    },
  };

  const meter = meterEventSchema.parse({
    inputTokens: 100,
    outputTokens: 40,
    cachedInputTokens: 20,
    latencyMs: 420,
    modelId: "cloud-model",
    locality: "external-api",
    aborted: false,
  });
  const a = toBudgetMeterTick(meter, { subjectId: "anika-k" });
  const b = toBudgetMeterTick(meter, { subjectId: "brian-m" });

  await invokeBudgetHook(hook, a);
  await invokeBudgetHook(hook, b);
  await invokeBudgetHook(hook, a); // replay

  assert.equal(spend.get("anika-k"), 120);
  assert.equal(spend.get("brian-m"), 120);
  assert.notEqual(spend.get("anika-k"), 240);
});

test("subject isolation: empty subjectId rejected; invalid decision rejected", async () => {
  assert.throws(
    () =>
      toBudgetMeterTick(
        meterEventSchema.parse({
          inputTokens: 1,
          outputTokens: 0,
          cachedInputTokens: 0,
          latencyMs: 1,
          modelId: "slm-local",
          locality: "on-device",
          aborted: false,
        }),
        { subjectId: "" },
      ),
    /subjectId/,
  );

  const bad = await invokeBudgetHook(
    { onMeterTick: () => /** @type {any} */ ("slow-down") },
    {
      subjectId: "anika-k",
      inputTokens: 1,
      outputTokens: 0,
      cachedInputTokens: 0,
      latencyMs: 1,
      modelId: "slm-local",
      locality: "on-device",
      aborted: false,
    },
  );
  assert.equal(bad.outcome, "rejected");
  assert.equal(bad.failureClass, "invalid_decision");
  assert.doesNotMatch(JSON.stringify(bad), /prompt|utterance/i);
});
