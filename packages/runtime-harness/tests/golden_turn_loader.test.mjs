/**
 * A P6 golden-turn fixture import + shared loader.
 * Run: pnpm --filter @moolam/runtime-harness test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  A_P6_GOLDEN_TURNS_FIXTURE_RELPATH,
  ToolCallParser,
  canonicalGoldenTurnBytes,
  loadGoldenTurnCorpus,
  parseChunks,
  resolveGoldenTurnFixtureDir,
  resolveUpstreamGoldenTurnDir,
} from "../dist/index.js";

function log(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function summarizeParse(events) {
  return events
    .filter((e) => e.type !== "mode_change")
    .map((e) => {
      if (
        e.type === "thought_delta" ||
        e.type === "answer_delta" ||
        e.type === "tool_buffer_delta"
      ) {
        return { type: e.type, delta: e.delta };
      }
      if (e.type === "tool_buffer") return { type: e.type, body: e.body };
      if (e.type === "violation") {
        return { type: e.type, failureClass: e.failureClass };
      }
      return e;
    });
}

test("happy path: loader imports A P6 corpus with upstream byte parity", () => {
  const telemetry = [];
  const loaded = loadGoldenTurnCorpus({
    deviceId: "edge-gt",
    onTelemetry: (e) => telemetry.push(e),
  });
  assert.equal(loaded.ok, true);
  assert.ok(loaded.fixtures.length >= 5);
  assert.equal(A_P6_GOLDEN_TURNS_FIXTURE_RELPATH, "fixtures/golden-turns");
  assert.ok(resolveGoldenTurnFixtureDir().endsWith("golden-turns"));
  assert.ok(resolveUpstreamGoldenTurnDir().includes("sync-protocol"));
  assert.ok(telemetry.some((t) => t.outcome === "ok" && t.turnCount >= 5));
  assert.ok(telemetry.every((t) => t.subjectId));
  assert.ok(!JSON.stringify(telemetry).includes("expectedFrames"));
  log({
    case: "load_corpus",
    outcome: "ok",
    turnCount: loaded.fixtures.length,
  });
});

test("edge: on-disk fixtures are byte-identical to A P6 upstream", () => {
  const loaded = loadGoldenTurnCorpus();
  assert.equal(loaded.ok, true);
  const upstream = resolveUpstreamGoldenTurnDir();
  for (const turn of loaded.manifest.turns) {
    const local = readFileSync(join(loaded.fixtureDir, turn.file), "utf8").replace(
      /\r\n/g,
      "\n",
    );
    const up = readFileSync(join(upstream, turn.file), "utf8").replace(
      /\r\n/g,
      "\n",
    );
    assert.equal(local, up, `drift in ${turn.file}`);
    const fixture = loaded.fixtures.find((f) => f.id === turn.id);
    assert.equal(canonicalGoldenTurnBytes(fixture), local);
  }
  log({ case: "byte_identical_upstream", outcome: "ok" });
});

test("edge: multi-chunk golden input — single feed and chunked feed match", () => {
  const loaded = loadGoldenTurnCorpus();
  assert.equal(loaded.ok, true);
  const basic = loaded.fixtures.find((f) => f.id === "thought-answer-basic");
  assert.ok(basic);
  const joined = basic.input.join("");
  const one = summarizeParse(
    parseChunks([joined], {
      subjectId: basic.subjectId,
      deviceId: basic.deviceId,
    }),
  );
  const many = summarizeParse(
    parseChunks(basic.input, {
      subjectId: basic.subjectId,
      deviceId: basic.deviceId,
    }),
  );
  assert.deepEqual(many, one);
  // Parser consumes subject-scoped input; does not mutate fixture bytes.
  assert.equal(loaded.rawById[basic.id], canonicalGoldenTurnBytes(basic));
  log({ case: "multi_chunk_input_match", outcome: "ok", id: basic.id });
});

test("edge: new A P6 golden without local update → upstream_drift", () => {
  const loaded = loadGoldenTurnCorpus();
  assert.equal(loaded.ok, true);
  const tmp = mkdtempSync(join(tmpdir(), "sutra-gt-up-"));
  try {
    // Fake upstream with an extra turn id.
    const manifest = {
      ...loaded.manifest,
      turns: [
        ...loaded.manifest.turns,
        { id: "brand-new-a-p6-turn", file: "brand-new-a-p6-turn.json" },
      ],
    };
    writeFileSync(join(tmp, "manifest.json"), JSON.stringify(manifest), "utf8");
    for (const turn of loaded.manifest.turns) {
      writeFileSync(
        join(tmp, turn.file),
        readFileSync(join(loaded.fixtureDir, turn.file)),
      );
    }
    writeFileSync(
      join(tmp, "brand-new-a-p6-turn.json"),
      readFileSync(join(loaded.fixtureDir, "tool-call-fence.json"), "utf8").replace(
        '"tool-call-fence"',
        '"brand-new-a-p6-turn"',
      ),
      "utf8",
    );
    const rejected = loadGoldenTurnCorpus({
      upstreamDir: tmp,
      requireUpstreamParity: true,
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.failureClass, "upstream_drift");
    assert.match(rejected.detail, /brand-new-a-p6-turn/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  log({ case: "upstream_new_golden", outcome: "rejected" });
});

test("sovereignty: every loaded frame subjectId matches fixture", () => {
  const loaded = loadGoldenTurnCorpus();
  assert.equal(loaded.ok, true);
  for (const fixture of loaded.fixtures) {
    assert.ok(fixture.subjectId.length > 0);
    for (const frame of fixture.expectedFrames) {
      assert.equal(frame.subjectId, fixture.subjectId);
    }
  }
  // ToolCallParser still requires subjectId when replaying inputs.
  assert.throws(() => new ToolCallParser({ subjectId: "" }), /subjectId/);
  log({ case: "subject_scope_frames", outcome: "ok" });
});
