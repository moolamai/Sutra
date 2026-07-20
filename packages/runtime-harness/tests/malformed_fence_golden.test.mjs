/**
 * Malformed-fence regression goldens (CK-07): unclosed / nested / undeclared
 * markup → typed violation, never answer payload with fence prose.
 *
 * Fixtures: fixtures/golden-turns/malformed-fence/ (not A P6 harness frames).
 * Run: pnpm --filter @moolam/runtime-harness test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalizeEventsJson,
  parseChunks,
  summarizeParseEvents,
  unifiedDiff,
} from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(
  __dirname,
  "..",
  "fixtures",
  "golden-turns",
  "malformed-fence",
);

const REQUIRED_SCENARIOS = new Set([
  "unclosed_fence",
  "nested_fence",
  "undeclared_markup",
]);

function log(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function loadManifest() {
  const raw = readFileSync(join(FIXTURE_DIR, "manifest.json"), "utf8");
  return JSON.parse(raw);
}

function loadCase(file) {
  const raw = readFileSync(join(FIXTURE_DIR, file), "utf8").replace(/\r\n/g, "\n");
  return { fixture: JSON.parse(raw), raw };
}

function replaySummarized(input, opts) {
  return summarizeParseEvents(parseChunks(input, opts));
}

function assertNeverForbiddenAnswer(events, forbidden, caseId) {
  const answers = events
    .filter((e) => e.type === "answer_delta")
    .map((e) => e.delta)
    .join("");
  for (const needle of forbidden) {
    assert.ok(
      !answers.includes(needle),
      `${caseId}: answer must not contain ${JSON.stringify(needle)}`,
    );
  }
}

test("happy path: every malformed-fence golden matches expectedEvents", () => {
  const manifest = loadManifest();
  assert.equal(manifest.specId, "CK-07");
  const seen = new Set();
  const telemetry = [];

  for (const entry of manifest.cases) {
    const { fixture } = loadCase(entry.file);
    assert.equal(fixture.id, entry.id);
    assert.equal(fixture.scenario, entry.scenario);
    assert.equal(fixture.specId, "CK-07");
    assert.ok(fixture.subjectId, fixture.id);
    seen.add(fixture.scenario);

    const opts = {
      subjectId: fixture.subjectId,
      deviceId: fixture.deviceId,
      onTelemetry: (e) => telemetry.push(e),
    };
    const actual = replaySummarized(fixture.input, opts);
    const actualJson = canonicalizeEventsJson(actual);
    const expectedJson = canonicalizeEventsJson(fixture.expectedEvents);
    if (actualJson !== expectedJson) {
      const diff = unifiedDiff(expectedJson, actualJson, {
        fromFile: `malformed/${fixture.id}.expected.json`,
        toFile: `malformed/${fixture.id}.actual.json`,
      });
      process.stdout.write(diff);
      assert.fail(`MALFORMED_FENCE_DRIFT:${fixture.id}\n${diff}`);
    }

    assert.ok(
      actual.some(
        (e) =>
          e.type === "violation" && e.failureClass === fixture.scenario,
      ),
      `${fixture.id}: expected violation ${fixture.scenario}`,
    );
    assertNeverForbiddenAnswer(
      actual,
      fixture.forbiddenAnswerSubstrings,
      fixture.id,
    );

    log({
      event: "runtime.harness.malformed_fence_golden",
      outcome: "ok",
      subjectId: fixture.subjectId,
      deviceId: fixture.deviceId,
      turnId: fixture.id,
      scenario: fixture.scenario,
      failureClass: fixture.scenario,
    });
  }

  for (const required of REQUIRED_SCENARIOS) {
    assert.ok(seen.has(required), `missing scenario golden: ${required}`);
  }

  assert.ok(telemetry.some((t) => t.outcome === "rejected"));
  assert.ok(telemetry.every((t) => t.subjectId === "anika-k"));
  assert.ok(!JSON.stringify(telemetry).includes("secret ratio"));
  assert.ok(!JSON.stringify(telemetry).includes("<foo>"));
});

test("edge: multi-chunk vs single-chunk feed match for each golden", () => {
  const manifest = loadManifest();
  for (const entry of manifest.cases) {
    const { fixture } = loadCase(entry.file);
    const opts = {
      subjectId: fixture.subjectId,
      deviceId: fixture.deviceId,
    };
    const stream = fixture.input.join("");
    const single = canonicalizeEventsJson(replaySummarized([stream], opts));
    for (let offset = 0; offset <= stream.length; offset++) {
      const chunks = [stream.slice(0, offset), stream.slice(offset)];
      const chunked = canonicalizeEventsJson(replaySummarized(chunks, opts));
      assert.equal(
        chunked,
        single,
        `${fixture.id}: split at ${offset} diverged`,
      );
    }
  }
  log({ case: "chunk_vs_joined", outcome: "ok" });
});

test("edge: language-neutral fixture JSON — no TS/Python artifacts", () => {
  const manifest = loadManifest();
  for (const entry of manifest.cases) {
    const { raw } = loadCase(entry.file);
    assert.doesNotMatch(raw, /undefined|NaN|Infinity/);
    assert.doesNotMatch(raw, /"\$type"|"__typename"|"__class__"/);
  }
  log({ case: "language_neutral", outcome: "ok" });
});

test("edge: forbidden answer substring would fail the suite (pre-fix path)", () => {
  // Simulates pre-fix routing of fence prose into answer_delta.
  const poison = summarizeParseEvents(
    parseChunks(["hello <foo>bar</foo>"], { subjectId: "anika-k" }),
  );
  poison.push({ type: "answer_delta", delta: "<foo>bar</foo>" });
  assert.throws(() => {
    assertNeverForbiddenAnswer(
      poison,
      ["<foo>", "bar"],
      "undeclared-markup-poison",
    );
  });
  log({ case: "pre_fix_answer_leak_detected", outcome: "ok" });
});

test("sovereignty: each golden requires subjectId; parser telemetry is scoped", () => {
  const manifest = loadManifest();
  for (const entry of manifest.cases) {
    const { fixture } = loadCase(entry.file);
    assert.throws(() => {
      parseChunks(fixture.input, { subjectId: "" });
    });
    const tel = [];
    parseChunks(fixture.input, {
      subjectId: fixture.subjectId,
      deviceId: fixture.deviceId,
      onTelemetry: (e) => tel.push(e),
    });
    assert.ok(tel.every((t) => t.subjectId === fixture.subjectId));
  }
  log({ case: "subject_scope", outcome: "ok" });
});

test("scalability: malformed corpus stays within soft caps", () => {
  const manifest = loadManifest();
  assert.ok(manifest.cases.length <= 32);
  for (const entry of manifest.cases) {
    const { fixture } = loadCase(entry.file);
    assert.ok(fixture.input.length <= 16);
    assert.ok(fixture.expectedEvents.length <= 32);
    const stream = fixture.input.join("");
    assert.ok(stream.length <= 512);
  }
  const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json"));
  assert.ok(files.includes("manifest.json"));
  assert.ok(files.length <= 16);
  log({ case: "budget", outcome: "ok", cases: manifest.cases.length });
});
