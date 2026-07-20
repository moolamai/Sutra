/**
 * PackKnowledgeConnector: load pack, retrieve (keyword/vector), describe().
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, copyFileSync, rmSync } from "node:fs";
import path from "node:path";
import {
  KNOWLEDGE_PACKAGE_ROOT,
  PackKnowledgeConnector,
  PackLoadError,
  createPackKnowledgeConnector,
} from "../dist/index.js";

const FIXTURES = path.join(KNOWLEDGE_PACKAGE_ROOT, "fixtures", "pack-v1");
const VALID_PACK = path.join(FIXTURES, "valid");
const FIXED_NOW_MS = Date.parse("2026-07-15T00:00:00.000Z");
const SECRET = "LEARNER_QUERY_MUST_NOT_APPEAR_IN_TELEMETRY";

test("happy path: load pack, describe bundled-offline + asOf, retrieve cited hits", async () => {
  const events = [];
  const connector = PackKnowledgeConnector.load({
    packRoot: VALID_PACK,
    subjectId: "subj.pack.load.valid",
    deviceId: "dev-loader",
    nowMs: FIXED_NOW_MS,
    onTelemetry: (e) => events.push(e),
  });

  const desc = connector.describe();
  assert.equal(desc.locality, "bundled-offline");
  assert.equal(desc.asOf, "2026-06-01T00:00:00.000Z");
  assert.equal(desc.packId, "pack.demo.cbse-math-slice");
  assert.ok(desc.sources.length >= 1);
  assert.equal(connector.sources.length, desc.sources.length);

  const hits = await connector.retrieve({
    query: "linear equation",
    limit: 4,
  });
  assert.ok(hits.length >= 1);
  for (const h of hits) {
    assert.ok(h.citation.trim().length > 0);
    assert.ok(desc.sources.some((s) => s.sourceId === h.sourceId));
    assert.ok(h.score > 0 && h.score <= 1);
    assert.ok(h.asOf);
  }
  assert.ok(events.some((e) => e.op === "load" && e.outcome === "ok"));
  assert.ok(events.some((e) => e.op === "retrieve" && e.outcome === "ok"));
  assert.ok(events.some((e) => e.op === "describe" && e.outcome === "ok"));
  assert.ok(!JSON.stringify(events).includes(SECRET));
  assert.ok(!JSON.stringify(events).includes("linear equation"));
});

test("edge: missing shard on disk throws PackLoadError naming the failure", () => {
  const tmp = path.join(FIXTURES, "packs", "_tmp-missing-shard");
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(path.join(tmp, "content"), { recursive: true });
  copyFileSync(
    path.join(VALID_PACK, "manifest.json"),
    path.join(tmp, "manifest.json"),
  );
  // intentionally omit content/shard-001.json
  assert.throws(
    () =>
      createPackKnowledgeConnector({
        packRoot: tmp,
        subjectId: "subj.pack.load.missing",
        nowMs: FIXED_NOW_MS,
      }),
    (err) => {
      assert.ok(err instanceof PackLoadError);
      assert.ok(
        err.failureClass === "config" || err.message.toLowerCase().includes("missing"),
      );
      return true;
    },
  );
  rmSync(tmp, { recursive: true, force: true });
});

test("edge: unknown sourceIds returns empty array (no fabricated passages)", async () => {
  const connector = PackKnowledgeConnector.load({
    packRoot: VALID_PACK,
    subjectId: "subj.pack.load.zerohit",
    nowMs: FIXED_NOW_MS,
  });
  const hits = await connector.retrieve({
    query: "linear equation",
    sourceIds: ["src.does-not-exist"],
    limit: 8,
  });
  assert.deepEqual(hits, []);
  const desc = connector.describe();
  assert.equal(desc.asOf, connector.asOf);
});

test("edge: bundled-offline degraded retrieve returns cited hits for unknown query tokens", async () => {
  const connector = PackKnowledgeConnector.load({
    packRoot: VALID_PACK,
    subjectId: "subj.pack.load.degraded",
    nowMs: FIXED_NOW_MS,
  });
  const hits = await connector.retrieve({
    query: "zzzz-no-such-token-qqqq",
    limit: 8,
  });
  assert.ok(hits.length >= 1);
  assert.ok(hits.every((h) => h.citation.trim() && h.score > 0));
});

test("sovereignty: telemetry is subject-scoped; retrieve does not leak query text", async () => {
  const events = [];
  const connector = PackKnowledgeConnector.load({
    packRoot: VALID_PACK,
    subjectId: "subj.pack.load.iso-a",
    deviceId: "dev-a",
    nowMs: FIXED_NOW_MS,
    onTelemetry: (e) => events.push(e),
  });
  await connector.retrieve({ query: SECRET, limit: 2 });
  PackKnowledgeConnector.load({
    packRoot: VALID_PACK,
    subjectId: "subj.pack.load.iso-b",
    deviceId: "dev-b",
    nowMs: FIXED_NOW_MS,
    onTelemetry: (e) => events.push(e),
  });
  assert.ok(events.some((e) => e.subjectId === "subj.pack.load.iso-a"));
  assert.ok(events.some((e) => e.subjectId === "subj.pack.load.iso-b"));
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test("idempotency: repeated retrieve yields stable cited results", async () => {
  const connector = PackKnowledgeConnector.load({
    packRoot: VALID_PACK,
    subjectId: "subj.pack.load.idem",
    nowMs: FIXED_NOW_MS,
  });
  const a = await connector.retrieve({ query: "linear equation", limit: 3 });
  const b = await connector.retrieve({ query: "linear equation", limit: 3 });
  assert.deepEqual(a, b);
  assert.ok(a.every((p) => p.citation.trim()));
});

test("scalability: retrieve limit is capped", async () => {
  const connector = PackKnowledgeConnector.load({
    packRoot: VALID_PACK,
    subjectId: "subj.pack.load.limit",
    nowMs: FIXED_NOW_MS,
  });
  const hits = await connector.retrieve({
    query: "equation",
    limit: 10_000,
  });
  assert.ok(hits.length <= 64);
});

