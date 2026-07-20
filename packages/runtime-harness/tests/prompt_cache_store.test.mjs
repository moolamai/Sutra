/**
 * In-memory static prompt cache — hash key lookup / store / getOrAssemble.
 * Run: pnpm --filter @moolam/runtime-harness test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryStaticPromptCache,
  PROMPT_STATIC_CACHE_ENTRY_LIMIT_MAX,
  assembleStatic,
  hashBindingsState,
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

test("happy path: miss then store then hit reuses static bytes", () => {
  const telemetry = [];
  const cache = new InMemoryStaticPromptCache({
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
    onTelemetry: (e) => telemetry.push(e),
  });
  const state = bindings();
  const hash = hashBindingsState(state);
  assert.equal(hash.ok, true);
  const assembled = assembleStatic(PROFILE, PROTOCOL);
  assert.equal(assembled.ok, true);

  const miss = cache.lookup(hash.hash);
  assert.equal(miss.ok, true);
  assert.equal(miss.hit, false);
  assert.equal(miss.missMarker, "cold");
  assert.equal(miss.hitRate, null); // first lookup — hit-rate undefined

  const stored = cache.store(hash.hash, assembled.block.text);
  assert.equal(stored.ok, true);
  assert.equal(stored.idempotentReplay, false);

  const hit = cache.lookup(hash.hash);
  assert.equal(hit.ok, true);
  assert.equal(hit.hit, true);
  assert.equal(hit.staticBlock, assembled.block.text);
  assert.equal(hit.bytesSaved, assembled.block.byteLength);
  assert.ok(typeof hit.hitRate === "number");
  assert.ok(hit.hitRate > 0);

  assert.ok(!JSON.stringify(telemetry).includes(PROFILE.charter));
  assert.ok(telemetry.some((t) => t.action === "cache_lookup" && t.cacheHit === false));
  assert.ok(telemetry.some((t) => t.action === "cache_lookup" && t.cacheHit === true));

  log({
    event: "runtime.harness.prompt_cache",
    outcome: "ok",
    case: "miss_then_hit",
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
    bindingsHash: hash.hash.slice(0, 12),
    bytesSaved: hit.bytesSaved,
  });
});

test("happy path: getOrAssembleStatic lookup before assembly; store on miss", () => {
  const cache = new InMemoryStaticPromptCache({ subjectId: "anika-k" });
  const first = cache.getOrAssembleStatic({ bindingsState: bindings() });
  assert.equal(first.ok, true);
  assert.equal(first.hit, false);
  assert.equal(first.assembled, true);
  assert.equal(first.missMarker, "cold");

  const second = cache.getOrAssembleStatic({ bindingsState: bindings() });
  assert.equal(second.ok, true);
  assert.equal(second.hit, true);
  assert.equal(second.assembled, false);
  assert.equal(second.staticBlock, first.staticBlock);
  assert.ok(second.bytesSaved > 0);
});

test("edge: bindings hash change never serves stale static charter", () => {
  const cache = new InMemoryStaticPromptCache({ subjectId: "anika-k" });
  const before = cache.getOrAssembleStatic({ bindingsState: bindings() });
  assert.equal(before.ok, true);

  const after = cache.getOrAssembleStatic({
    bindingsState: bindings({
      profile: { ...PROFILE, charter: "Updated charter — new framing." },
    }),
  });
  assert.equal(after.ok, true);
  assert.equal(after.hit, false);
  assert.notEqual(after.bindingsHash, before.bindingsHash);
  assert.notEqual(after.staticBlock, before.staticBlock);
  assert.ok(after.staticBlock.includes("Updated charter"));
  // Prior entry remains under old hash — not served for new hash.
  const oldStill = cache.lookup(before.bindingsHash);
  assert.equal(oldStill.ok, true);
  assert.equal(oldStill.hit, true);
  assert.equal(oldStill.staticBlock, before.staticBlock);
});

test("edge: LRU eviction under pressure returns miss, not stale serve", () => {
  const cache = new InMemoryStaticPromptCache({
    subjectId: "anika-k",
    maxEntries: 2,
  });
  assert.ok(cache.maxEntries <= PROMPT_STATIC_CACHE_ENTRY_LIMIT_MAX);

  const h1 = cache.getOrAssembleStatic({
    bindingsState: bindings({ bindingFields: { modelId: "m1" } }),
  });
  const h2 = cache.getOrAssembleStatic({
    bindingsState: bindings({ bindingFields: { modelId: "m2" } }),
  });
  const h3 = cache.getOrAssembleStatic({
    bindingsState: bindings({ bindingFields: { modelId: "m3" } }),
  });
  assert.equal(h1.ok && h2.ok && h3.ok, true);
  assert.equal(cache.size, 2);
  assert.ok(cache.stats.evictions >= 1);

  const evicted = cache.lookup(h1.bindingsHash);
  assert.equal(evicted.ok, true);
  assert.equal(evicted.hit, false);
  assert.equal(evicted.missMarker, "cold");
});

test("edge: TTL expiry misses without serving stale static block", () => {
  let now = 1_000;
  const cache = new InMemoryStaticPromptCache({
    subjectId: "anika-k",
    ttlMs: 100,
    now: () => now,
  });
  const first = cache.getOrAssembleStatic({ bindingsState: bindings() });
  assert.equal(first.ok, true);
  assert.equal(first.hit, false);

  now = 1_050;
  const stillFresh = cache.lookup(first.bindingsHash);
  assert.equal(stillFresh.ok, true);
  assert.equal(stillFresh.hit, true);

  now = 1_200;
  const expired = cache.lookup(first.bindingsHash);
  assert.equal(expired.ok, true);
  assert.equal(expired.hit, false);
  assert.equal(expired.missMarker, "ttl_expired");
  assert.equal(cache.size, 0);
});

test("sovereignty: cross-subject getOrAssemble rejected; no charter in telemetry", () => {
  const telemetry = [];
  const cache = new InMemoryStaticPromptCache({
    subjectId: "anika-k",
    onTelemetry: (e) => telemetry.push(e),
  });
  const bad = cache.getOrAssembleStatic({
    bindingsState: bindings({ subjectId: "jamie-r" }),
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.failureClass, "cross_subject");
  assert.ok(!JSON.stringify(telemetry).includes(PROFILE.charter));
});

test("scalability: store is idempotent; invalidate clears entries", () => {
  const cache = new InMemoryStaticPromptCache({ subjectId: "anika-k" });
  const got = cache.getOrAssembleStatic({ bindingsState: bindings() });
  assert.equal(got.ok, true);
  const again = cache.store(got.bindingsHash, got.staticBlock);
  assert.equal(again.ok, true);
  assert.equal(again.idempotentReplay, true);

  const cleared = cache.invalidate(got.bindingsHash);
  assert.equal(cleared.removed, 1);
  const miss = cache.lookup(got.bindingsHash);
  assert.equal(miss.ok, true);
  assert.equal(miss.hit, false);
});
