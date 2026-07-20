/**
 * Event catalog reference doc consistency with Zod examples.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CATALOG_EVENT_TYPES,
  CATALOG_WORKED_EXAMPLES,
  EVENT_CATALOG_DOC_RELPATH,
  FORBIDDEN_CATALOG_PAYLOAD_KEYS,
  parseCatalogEvent,
} from "../dist/index.js";

const OBS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOC_PATH = path.join(OBS_ROOT, EVENT_CATALOG_DOC_RELPATH);
const RUNTIME_README = path.resolve(OBS_ROOT, "../runtime/README.md");

test("happy path: doc documents every catalog type with a real worked example", async () => {
  const doc = (await readFile(DOC_PATH, "utf8")).replace(/\r\n/g, "\n");
  assert.match(doc, /Privacy rule/i);
  assert.match(doc, /createValidatingEventBus/);

  for (const type of CATALOG_EVENT_TYPES) {
    assert.match(
      doc,
      new RegExp(`### \\\`${type.replace(/\./g, "\\.")}\\\``),
      `missing heading for ${type}`,
    );
    assert.match(doc, new RegExp(`"type":\\s*"${type.replace(/\./g, "\\.")}"`));
  }

  const blocks = [...doc.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.ok(blocks.length >= CATALOG_EVENT_TYPES.length);

  /** @type {Set<string>} */
  const seenTypes = new Set();
  for (const block of blocks) {
    let parsed;
    try {
      parsed = JSON.parse(block);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || !parsed.type) continue;
    if (!CATALOG_EVENT_TYPES.includes(parsed.type)) continue;
    const result = parseCatalogEvent(parsed);
    assert.equal(result.ok, true, `${parsed.type}: ${result.ok ? "" : result.error}`);
    seenTypes.add(parsed.type);
    // Must match the programmatic worked example (examples are real).
    assert.deepEqual(
      parsed,
      CATALOG_WORKED_EXAMPLES[parsed.type],
      `${parsed.type} doc example drifted from CATALOG_WORKED_EXAMPLES`,
    );
  }
  assert.equal(seenTypes.size, CATALOG_EVENT_TYPES.length);
});

test("edge: doc covers subscriber-error isolation and folded friction rule", async () => {
  const doc = (await readFile(DOC_PATH, "utf8")).replace(/\r\n/g, "\n");
  assert.match(doc, /runtime\.subscriber-error/);
  assert.match(doc, /Subscriber throws/i);
  assert.match(doc, /folded/i);
  assert.match(doc, /cross the bus/i);
  assert.doesNotMatch(doc, /friction\.raw/);
});

test("sovereignty: doc examples never include forbidden learner keys", async () => {
  const doc = (await readFile(DOC_PATH, "utf8")).replace(/\r\n/g, "\n");
  const blocks = [...doc.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);
  for (const block of blocks) {
    let parsed;
    try {
      parsed = JSON.parse(block);
    } catch {
      continue;
    }
    if (!parsed?.payload || typeof parsed.payload !== "object") continue;
    for (const key of FORBIDDEN_CATALOG_PAYLOAD_KEYS) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(parsed.payload, key),
        false,
        `doc example leaked ${key}`,
      );
    }
  }
  assert.doesNotMatch(doc, /GOLDEN_UTTERANCE|what is a ratio/i);
});

test("edge: runtime README links implementors to the catalog doc", async () => {
  const readme = await readFile(RUNTIME_README, "utf8");
  assert.match(readme, /observability\/docs\/event-catalog\.md/);
  assert.match(readme, /Event catalog/);
  assert.match(readme, /createValidatingEventBus/);
});
