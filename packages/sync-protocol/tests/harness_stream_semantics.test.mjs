/**
 * Consistency gate for docs/protocol/HARNESS-STREAM-SEMANTICS.md.
 *
 * Happy path: doc exists, linked from package + public protocol READMEs,
 * catalogues every frame type with real golden-fixture examples.
 * Edge: SEQUENCE_GAP / last-seen replay / HARNESS_ERROR terminal rules;
 * subject isolation + observability (no raw delta exfiltration claims).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HARNESS_FRAME_TYPES,
  assertMonotonicSequence,
  harnessFrameSchema,
} from "../dist/index.js";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(PKG_ROOT, "..", "..");
const DOC = path.join(REPO_ROOT, "docs", "protocol", "HARNESS-STREAM-SEMANTICS.md");
const PKG_README = path.join(PKG_ROOT, "README.md");
const PROTOCOL_README = path.join(REPO_ROOT, "docs", "protocol", "README.md");
const FIXTURE = path.join(PKG_ROOT, "fixtures", "wire-parity", "harness-frames.json");
const SCHEMA = path.join(PKG_ROOT, "schemas", "HarnessFrame.json");

/** Structured progress — never frame delta text. */
function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

test("happy path: semantics doc published and linked", async () => {
  const doc = await readFile(DOC, "utf8");
  const pkgReadme = await readFile(PKG_README, "utf8");
  const protocolReadme = await readFile(PROTOCOL_README, "utf8");

  assert.match(doc, /sequenceIndex/);
  assert.match(doc, /SEQUENCE_GAP/);
  assert.match(doc, /lastSeenSequenceIndex|last-seen/i);
  assert.match(doc, /HARNESS_ERROR/);
  assert.match(pkgReadme, /HARNESS-STREAM-SEMANTICS\.md/);
  assert.match(protocolReadme, /HARNESS-STREAM-SEMANTICS\.md/);
  emit({
    event: "harness.stream.semantics",
    outcome: "ok",
    kind: "doc.linked",
    subjectId: null,
  });
});

test("happy path: doc catalogues every frame type; golden examples parse", async () => {
  const doc = await readFile(DOC, "utf8");
  const golden = JSON.parse(await readFile(FIXTURE, "utf8"));
  const schema = JSON.parse(await readFile(SCHEMA, "utf8"));

  assert.equal(HARNESS_FRAME_TYPES.length, 8);
  for (const typeName of HARNESS_FRAME_TYPES) {
    assert.match(doc, new RegExp(`\`${typeName}\``), `doc must name ${typeName}`);
  }

  const frames = golden.frames.map((raw) => harnessFrameSchema.parse(raw));
  assert.equal(frames.length, 8);
  const mono = assertMonotonicSequence(frames);
  assert.equal(mono.ok, true);

  // Doc's contiguous example uses indices 0,1,2 from the same fixture subject.
  assert.match(doc, /"sequenceIndex": 0/);
  assert.match(doc, /"sequenceIndex": 1/);
  assert.match(doc, /"sequenceIndex": 2/);
  assert.match(doc, /anika-k/);

  assert.equal(schema.title, "HarnessFrame");
  emit({
    event: "harness.stream.semantics",
    outcome: "ok",
    kind: "doc.catalogue",
    subjectId: "anika-k",
    frameCount: frames.length,
  });
});

test("edge: SEQUENCE_GAP example matches assertMonotonicSequence", async () => {
  const doc = await readFile(DOC, "utf8");
  assert.match(doc, /expected: 2/);
  assert.match(doc, /actual: 99/);

  const gap = assertMonotonicSequence([
    { sequenceIndex: 0, subjectId: "anika-k" },
    { sequenceIndex: 1, subjectId: "anika-k" },
    { sequenceIndex: 99, subjectId: "anika-k" },
  ]);
  assert.equal(gap.ok, false);
  assert.equal(gap.code, "SEQUENCE_GAP");
  assert.equal(gap.expected, 2);
  assert.equal(gap.actual, 99);
  assert.equal(gap.subjectId, "anika-k");

  emit({
    event: "harness.stream.semantics",
    outcome: "ok",
    kind: "sequence.gap",
    subjectId: "anika-k",
    code: "SEQUENCE_GAP",
  });
});

test("edge: reconnect / terminal / concurrency rules + sovereignty", async () => {
  const doc = await readFile(DOC, "utf8");

  assert.match(doc, /lastSeenSequenceIndex/);
  assert.match(doc, /lossless/i);
  assert.match(doc, /recoverable/);
  assert.match(doc, /STREAM_TRUNCATED/);
  assert.match(doc, /TURN_COMPLETE/);
  assert.match(doc, /[Ii]dempotent/);
  assert.match(doc, /[Cc]oncurrent/);
  assert.match(doc, /correlationId/);

  // Subject isolation — empty subject rejected; cross-subject is a defect.
  assert.match(doc, /subjectId/);
  assert.match(doc, /cross-subject/i);
  assert.match(doc, /reject/i);

  // Observability: metadata only — doc must forbid logging raw deltas.
  assert.match(doc, /[Nn]ever.*delta|omit raw deltas|never thought\/answer/i);
  assert.doesNotMatch(doc, /\bexfiltrat/i);

  // Golden HARNESS_ERROR example in the doc matches the fixture terminal.
  const golden = JSON.parse(await readFile(FIXTURE, "utf8"));
  const err = golden.frames.find((f) => f.type === "HARNESS_ERROR");
  assert.ok(err);
  assert.match(doc, new RegExp(`"code": "${err.code}"`));
  assert.match(doc, /"recoverable": true/);

  emit({
    event: "harness.stream.semantics",
    outcome: "ok",
    kind: "doc.edgeContracts",
    subjectId: err.subjectId,
    deviceId: null,
  });
});
