/**
 * Wire static-cache hit-rate to TurnMeter (cached vs fresh input tokens).
 * Run: pnpm --filter @moolam/runtime-harness test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryStaticPromptCache,
  TurnMeter,
  estimateStaticBlockTokens,
  meterCachedStaticAssembly,
} from "../dist/index.js";

function log(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

const PROFILE = {
  domainId: "mathematics-mentor",
  charter: "You are a patient tutor. Stay within elementary scope.",
  refusals: ["medical-advice", "legal-advice"],
  languages: ["en", "hi"],
};

const PROTOCOL = {
  protocolVersion: "1.0.0",
  instructions: "Use thought/answer fences. Never invent citations.",
};

function bindings(overrides = {}) {
  return {
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
    profile: PROFILE,
    protocol: PROTOCOL,
    bindingFields: { modelId: "slm-local" },
    ...overrides,
  };
}

function meter(overrides = {}) {
  let t = 1_000;
  return new TurnMeter({
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
    modelId: "slm-local",
    locality: "on-device",
    startedAtMs: 1_000,
    now: () => {
      t += 10;
      return t;
    },
    ...overrides,
  });
}

test("happy path: miss meters static as fresh; hit meters cachedInputTokens", () => {
  const telemetry = [];
  const cache = new InMemoryStaticPromptCache({
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
  });
  const m = meter();

  const miss = meterCachedStaticAssembly({
    cache,
    meter: m,
    bindingsState: bindings(),
    dynamicFreshInputTokens: 5,
    outputTokens: 2,
    idempotencyKey: "turn-1",
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(miss.ok, true);
  assert.equal(miss.cacheHit, false);
  assert.equal(miss.cache_hit, false);
  assert.equal(miss.cachedInputTokens, 0);
  assert.equal(
    miss.freshInputTokens,
    miss.staticTokenEstimate + 5,
  );
  assert.equal(
    miss.staticTokenEstimate,
    estimateStaticBlockTokens(miss.staticBlock),
  );

  const hit = meterCachedStaticAssembly({
    cache,
    meter: m,
    bindingsState: bindings(),
    dynamicFreshInputTokens: 5,
    outputTokens: 1,
    idempotencyKey: "turn-2",
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(hit.ok, true);
  assert.equal(hit.cacheHit, true);
  assert.equal(hit.cache_hit, true);
  assert.equal(hit.cachedInputTokens, hit.staticTokenEstimate);
  assert.equal(hit.freshInputTokens, 5);
  assert.ok(hit.bytesSaved > 0);
  assert.ok(typeof hit.hitRate === "number");

  const flushed = m.flush();
  assert.equal(flushed.ok, true);
  assert.equal(flushed.totals.cachedInputTokens, hit.staticTokenEstimate);
  assert.equal(
    flushed.totals.inputTokens,
    miss.freshInputTokens + hit.freshInputTokens,
  );
  assert.equal(flushed.totals.outputTokens, 3);

  const wire = telemetry.filter((t) => t.action === "meter_cache_assembly");
  assert.equal(wire.length, 2);
  assert.equal(wire[0].cache_hit, false);
  assert.equal(wire[1].cache_hit, true);
  assert.ok(!JSON.stringify(telemetry).includes(PROFILE.charter));

  log({
    event: "runtime.harness.prompt_cache",
    outcome: "ok",
    case: "meter_cache_hit",
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
    cache_hit: true,
    cachedInputTokens: hit.cachedInputTokens,
    freshInputTokens: hit.freshInputTokens,
  });
});

test("edge: bindings change → miss path; cached vs fresh stay distinguishable", () => {
  const cache = new InMemoryStaticPromptCache({ subjectId: "anika-k" });
  const m = meter();

  const first = meterCachedStaticAssembly({
    cache,
    meter: m,
    bindingsState: bindings(),
    dynamicFreshInputTokens: 0,
    idempotencyKey: "a",
  });
  assert.equal(first.ok, true);
  assert.equal(first.cache_hit, false);

  const warmed = meterCachedStaticAssembly({
    cache,
    meter: m,
    bindingsState: bindings(),
    dynamicFreshInputTokens: 0,
    idempotencyKey: "b",
  });
  assert.equal(warmed.ok, true);
  assert.equal(warmed.cache_hit, true);

  const mutated = meterCachedStaticAssembly({
    cache,
    meter: m,
    bindingsState: bindings({
      profile: { ...PROFILE, charter: "Updated charter — new framing." },
    }),
    dynamicFreshInputTokens: 3,
    idempotencyKey: "c",
  });
  assert.equal(mutated.ok, true);
  assert.equal(mutated.cache_hit, false);
  assert.equal(mutated.cachedInputTokens, 0);
  assert.equal(mutated.freshInputTokens, mutated.staticTokenEstimate + 3);
  assert.notEqual(mutated.bindingsHash, warmed.bindingsHash);

  const flushed = m.flush();
  assert.equal(flushed.ok, true);
  // Only the warmed hit contributed cached tokens.
  assert.equal(flushed.totals.cachedInputTokens, warmed.cachedInputTokens);
  assert.ok(flushed.totals.inputTokens > flushed.totals.cachedInputTokens);
});

test("edge: metering survives abort — partial cached spend still flushed", () => {
  const cache = new InMemoryStaticPromptCache({ subjectId: "anika-k" });
  const m = meter();
  meterCachedStaticAssembly({
    cache,
    meter: m,
    bindingsState: bindings(),
    dynamicFreshInputTokens: 1,
    idempotencyKey: "cold",
  });
  const hit = meterCachedStaticAssembly({
    cache,
    meter: m,
    bindingsState: bindings(),
    dynamicFreshInputTokens: 1,
    idempotencyKey: "warm",
  });
  assert.equal(hit.ok, true);
  assert.equal(hit.cache_hit, true);
  m.markAborted();
  const flushed = m.flush({ aborted: true });
  assert.equal(flushed.ok, true);
  assert.equal(flushed.aborted, true);
  assert.equal(flushed.totals.cachedInputTokens, hit.cachedInputTokens);
});

test("sovereignty: cross-subject meter rejected; telemetry has no charter", () => {
  const telemetry = [];
  const cache = new InMemoryStaticPromptCache({ subjectId: "anika-k" });
  const foreign = meter({ subjectId: "jamie-r" });
  const bad = meterCachedStaticAssembly({
    cache,
    meter: foreign,
    bindingsState: bindings(),
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.failureClass, "cross_subject");
  assert.ok(!JSON.stringify(telemetry).includes(PROFILE.charter));
});

test("scalability: idempotent replay does not double-count cache tokens", () => {
  const cache = new InMemoryStaticPromptCache({ subjectId: "anika-k" });
  const m = meter();
  const seed = meterCachedStaticAssembly({
    cache,
    meter: m,
    bindingsState: bindings(),
    idempotencyKey: "seed",
  });
  assert.equal(seed.ok, true);
  const a = meterCachedStaticAssembly({
    cache,
    meter: m,
    bindingsState: bindings(),
    dynamicFreshInputTokens: 2,
    idempotencyKey: "same-turn",
  });
  const b = meterCachedStaticAssembly({
    cache,
    meter: m,
    bindingsState: bindings(),
    dynamicFreshInputTokens: 2,
    idempotencyKey: "same-turn",
  });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.cache_hit, true);
  assert.equal(b.meterRecord.duplicate, true);

  const flushed = m.flush();
  assert.equal(flushed.ok, true);
  // Duplicate idem key must not add a second cached/fresh delta.
  assert.equal(flushed.totals.cachedInputTokens, a.cachedInputTokens);
  assert.equal(
    flushed.totals.inputTokens,
    seed.freshInputTokens + a.freshInputTokens,
  );
});
