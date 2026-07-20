/**
 * Content-addressed bindings state hash.
 * Run: pnpm --filter @moolam/runtime-harness test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  PROMPT_BINDINGS_FIELD_KEY_LIMIT,
  PROMPT_BINDINGS_HASH_ALGORITHM,
  canonicalizeBindingsStateJson,
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

test("happy path: identical bindings state yields identical restart-stable hash", () => {
  const telemetry = [];
  const a = hashBindingsState(
    {
      subjectId: "anika-k",
      deviceId: "edge-aaaa",
      profile: PROFILE,
      protocol: PROTOCOL,
      bindingFields: { modelId: "slm-local", knowledgeSourceIds: ["pack-a"] },
    },
    { onTelemetry: (e) => telemetry.push(e) },
  );
  const b = hashBindingsState({
    subjectId: "anika-k",
    deviceId: "edge-bbbb",
    profile: { ...PROFILE },
    protocol: { ...PROTOCOL },
    bindingFields: { modelId: "slm-local", knowledgeSourceIds: ["pack-a"] },
  });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.hash, b.hash);
  assert.equal(a.algorithm, PROMPT_BINDINGS_HASH_ALGORITHM);
  assert.equal(a.hash.length, 64);
  assert.match(a.hash, /^[0-9a-f]{64}$/);

  const canonical = canonicalizeBindingsStateJson({
    subjectId: "anika-k",
    profile: PROFILE,
    protocol: PROTOCOL,
    bindingFields: { modelId: "slm-local", knowledgeSourceIds: ["pack-a"] },
  });
  const expected = createHash("sha256").update(canonical, "utf8").digest("hex");
  assert.equal(a.hash, expected);
  assert.equal(a.canonicalByteLength, Buffer.byteLength(canonical, "utf8"));

  assert.equal(telemetry.length, 1);
  assert.equal(telemetry[0].action, "hash_bindings");
  assert.equal(telemetry[0].bindingsHash, a.hash);
  assert.ok(!JSON.stringify(telemetry).includes(PROFILE.charter));
  assert.ok(!JSON.stringify(telemetry).includes(PROTOCOL.instructions));

  log({
    event: "runtime.harness.prompt_cache",
    outcome: "ok",
    case: "hash_stable",
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
    bindingsHash: a.hash.slice(0, 12),
  });
});

test("edge: object key / list insertion order does not flap the hash", () => {
  const left = hashBindingsState({
    subjectId: "anika-k",
    profile: {
      domainId: "mathematics-mentor",
      charter: PROFILE.charter,
      languages: ["hi", "en"],
      refusals: ["legal-advice", "medical-advice"],
    },
    protocol: PROTOCOL,
    bindingFields: { z: 1, a: 2 },
  });
  const right = hashBindingsState({
    subjectId: "anika-k",
    profile: {
      domainId: "mathematics-mentor",
      charter: PROFILE.charter,
      languages: ["en", "hi"],
      refusals: ["medical-advice", "legal-advice"],
    },
    protocol: PROTOCOL,
    bindingFields: { a: 2, z: 1 },
  });
  assert.equal(left.ok, true);
  assert.equal(right.ok, true);
  assert.equal(left.hash, right.hash);

  const canonA = canonicalizeBindingsStateJson({
    subjectId: "anika-k",
    profile: {
      ...PROFILE,
      languages: ["hi", "en"],
      refusals: ["legal-advice", "medical-advice"],
    },
    protocol: PROTOCOL,
    bindingFields: { z: 1, a: 2 },
  });
  const canonB = canonicalizeBindingsStateJson({
    subjectId: "anika-k",
    profile: PROFILE,
    protocol: PROTOCOL,
    bindingFields: { a: 2, z: 1 },
  });
  assert.equal(canonA, canonB);
});

test("edge: charter update changes bindings hash (cache miss)", () => {
  const before = hashBindingsState({
    subjectId: "anika-k",
    profile: PROFILE,
    protocol: PROTOCOL,
  });
  const after = hashBindingsState({
    subjectId: "anika-k",
    profile: { ...PROFILE, charter: "Updated charter — new framing." },
    protocol: PROTOCOL,
  });
  assert.equal(before.ok, true);
  assert.equal(after.ok, true);
  assert.notEqual(before.hash, after.hash);
});

test("edge: bindingFields mutation invalidates hash; dynamic utterance not hashed", () => {
  const base = {
    subjectId: "anika-k",
    profile: PROFILE,
    protocol: PROTOCOL,
    bindingFields: { modelId: "slm-local" },
  };
  const a = hashBindingsState(base);
  const b = hashBindingsState({
    ...base,
    bindingFields: { modelId: "slm-local-v2" },
  });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.notEqual(a.hash, b.hash);

  // Utterance / memories are outside PromptBindingsState — same hash inputs
  // remain identical regardless of turn dynamic content (assembly is separate).
  const again = hashBindingsState({
    subjectId: "anika-k",
    profile: PROFILE,
    protocol: PROTOCOL,
    bindingFields: { modelId: "slm-local" },
  });
  assert.equal(again.ok, true);
  assert.equal(again.hash, a.hash);
});

test("sovereignty: missing subjectId rejected; distinct subjects never share digest", () => {
  const telemetry = [];
  const missing = hashBindingsState(
    { subjectId: "", profile: PROFILE, protocol: PROTOCOL },
    { onTelemetry: (e) => telemetry.push(e) },
  );
  assert.equal(missing.ok, false);
  assert.equal(missing.failureClass, "missing_subject");
  assert.ok(!JSON.stringify(telemetry).includes(PROFILE.charter));

  const s1 = hashBindingsState({
    subjectId: "anika-k",
    profile: PROFILE,
    protocol: PROTOCOL,
  });
  const s2 = hashBindingsState({
    subjectId: "jamie-r",
    profile: PROFILE,
    protocol: PROTOCOL,
  });
  assert.equal(s1.ok, true);
  assert.equal(s2.ok, true);
  assert.notEqual(s1.hash, s2.hash);
});

test("scalability: bindingFields key count is hard-capped", () => {
  const fields = Object.fromEntries(
    Array.from({ length: PROMPT_BINDINGS_FIELD_KEY_LIMIT + 1 }, (_, i) => [
      `k${i}`,
      i,
    ]),
  );
  const over = hashBindingsState({
    subjectId: "anika-k",
    profile: PROFILE,
    protocol: PROTOCOL,
    bindingFields: fields,
  });
  assert.equal(over.ok, false);
  assert.equal(over.failureClass, "section_limit");
});
