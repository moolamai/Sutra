/**
 * Static/dynamic prompt block splitter.
 * Run: pnpm --filter @moolam/runtime-harness test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  PROMPT_BLOCK_MARKERS,
  PROMPT_DYNAMIC_MEMORY_LIMIT,
  assembleDynamic,
  assemblePrompt,
  assembleStatic,
  canonicalizeProfileMetaJson,
  splitPromptBlocks,
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

test("happy path: assembleStatic + assembleDynamic with documented boundaries", () => {
  const telemetry = [];
  const staticResult = assembleStatic(PROFILE, PROTOCOL, {
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(staticResult.ok, true);
  assert.ok(staticResult.block.text.startsWith(PROMPT_BLOCK_MARKERS.staticOpen));
  assert.ok(staticResult.block.text.includes(PROMPT_BLOCK_MARKERS.charter));
  assert.ok(staticResult.block.text.includes(PROMPT_BLOCK_MARKERS.protocol));
  assert.ok(staticResult.block.text.includes(PROMPT_BLOCK_MARKERS.profile));
  assert.ok(staticResult.block.text.endsWith(PROMPT_BLOCK_MARKERS.staticClose));
  assert.ok(staticResult.block.text.includes(PROFILE.charter));
  assert.ok(staticResult.block.text.includes("version: 1.0.0"));

  const dynamicResult = assembleDynamic(
    {
      subjectId: "anika-k",
      deviceId: "edge-aaaa",
      sessionId: "sess-1",
      utterance: "Explain ratios.",
      memories: [{ id: "mem-1", kind: "episodic", text: "prior fraction lesson" }],
      passages: [{ id: "p-1", sourceId: "pack-a", text: "a:b means a/b" }],
    },
    { onTelemetry: (e) => telemetry.push(e) },
  );
  assert.equal(dynamicResult.ok, true);
  assert.equal(dynamicResult.memoryCount, 1);
  assert.equal(dynamicResult.passageCount, 1);
  assert.ok(
    dynamicResult.block.text.startsWith(PROMPT_BLOCK_MARKERS.dynamicOpen),
  );
  assert.ok(dynamicResult.block.text.includes(PROMPT_BLOCK_MARKERS.utterance));
  assert.ok(dynamicResult.block.text.includes("Explain ratios."));

  const combined = assemblePrompt({
    profile: PROFILE,
    protocol: PROTOCOL,
    turnContext: {
      subjectId: "anika-k",
      utterance: "Explain ratios.",
      memories: [],
      passages: [],
    },
  });
  assert.equal(combined.ok, true);
  const split = splitPromptBlocks(combined.prompt.combined);
  assert.equal(split.ok, true);
  assert.equal(split.staticText, combined.prompt.staticBlock.text);
  assert.equal(split.dynamicText, combined.prompt.dynamicBlock.text);

  assert.ok(telemetry.every((t) => t.event === "runtime.harness.prompt_cache"));
  assert.ok(!JSON.stringify(telemetry).includes("Explain ratios"));
  assert.ok(!JSON.stringify(telemetry).includes(PROFILE.charter));

  log({
    event: "runtime.harness.prompt_cache",
    outcome: "ok",
    case: "boundaries",
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
  });
});

test("invariant: static bytes identical across turns when profile/protocol unchanged", () => {
  const a = assembleStatic(PROFILE, PROTOCOL);
  const b = assembleStatic(
    {
      ...PROFILE,
      refusals: ["legal-advice", "medical-advice"], // different insert order
      languages: ["hi", "en"],
    },
    PROTOCOL,
  );
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.block.text, b.block.text);

  const turn1 = assemblePrompt({
    profile: PROFILE,
    protocol: PROTOCOL,
    turnContext: { subjectId: "anika-k", utterance: "q1" },
  });
  const turn2 = assemblePrompt({
    profile: PROFILE,
    protocol: PROTOCOL,
    turnContext: { subjectId: "anika-k", utterance: "q2 different" },
  });
  assert.equal(turn1.ok, true);
  assert.equal(turn2.ok, true);
  assert.equal(turn1.prompt.staticBlock.text, turn2.prompt.staticBlock.text);
  assert.notEqual(turn1.prompt.dynamicBlock.text, turn2.prompt.dynamicBlock.text);
});

test("edge: charter update changes static block bytes", () => {
  const before = assembleStatic(PROFILE, PROTOCOL);
  const after = assembleStatic(
    { ...PROFILE, charter: "Updated charter — new refusals framing." },
    PROTOCOL,
  );
  assert.equal(before.ok, true);
  assert.equal(after.ok, true);
  assert.notEqual(before.block.text, after.block.text);
});

test("edge: empty dynamic block (static-only) is valid", () => {
  const dyn = assembleDynamic({
    subjectId: "anika-k",
    utterance: "",
    memories: [],
    passages: [],
  });
  assert.equal(dyn.ok, true);
  assert.equal(dyn.memoryCount, 0);
  assert.equal(dyn.passageCount, 0);
  assert.equal(dyn.utteranceCharLength, 0);
  assert.ok(dyn.block.text.includes(PROMPT_BLOCK_MARKERS.utterance));
  assert.ok(dyn.block.text.includes(PROMPT_BLOCK_MARKERS.memories));
  assert.ok(dyn.block.text.includes(PROMPT_BLOCK_MARKERS.passages));
});

test("edge: profile meta canonicalization sorts keys and list order", () => {
  const left = canonicalizeProfileMetaJson({
    domainId: "d",
    languages: ["b", "a"],
    refusals: ["z", "y"],
  });
  const right = canonicalizeProfileMetaJson({
    domainId: "d",
    refusals: ["y", "z"],
    languages: ["a", "b"],
  });
  assert.equal(left, right);
  assert.ok(left.includes('"languages":["a","b"]'));
  assert.ok(left.includes('"refusals":["y","z"]'));
});

test("sovereignty: missing subjectId rejected; telemetry has no utterance", () => {
  const telemetry = [];
  const bad = assembleDynamic(
    { subjectId: "", utterance: "secret learner text" },
    { onTelemetry: (e) => telemetry.push(e) },
  );
  assert.equal(bad.ok, false);
  assert.equal(bad.failureClass, "missing_subject");
  assert.ok(!JSON.stringify(telemetry).includes("secret learner text"));
});

test("scalability: memory list is hard-capped", () => {
  const memories = Array.from({ length: PROMPT_DYNAMIC_MEMORY_LIMIT + 1 }, (_, i) => ({
    id: `m${i}`,
    text: `item ${i}`,
  }));
  const over = assembleDynamic({
    subjectId: "anika-k",
    utterance: "x",
    memories,
  });
  assert.equal(over.ok, false);
  assert.equal(over.failureClass, "section_limit");
});
