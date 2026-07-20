/**
 * GGUF metadata parser — truthful SlmModelCard fields from fixtures.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  GGUF_MAGIC,
  LLAMA_CPP_PINNED_REVISION,
  parseGgufMetadata,
  writeMinimalGguf,
} from "../dist/index.js";

test("parseMinimalGguf: card fields from header KV", () => {
  const bytes = writeMinimalGguf({
    name: "phi-fixture-q4",
    contextLength: 8192,
    fileType: 15,
    languages: ["en", "hi"],
  });
  assert.equal(Buffer.from(bytes.subarray(0, 4)).toString("ascii"), GGUF_MAGIC);

  const meta = parseGgufMetadata(bytes);
  assert.equal(meta.modelId, "phi-fixture-q4");
  assert.equal(meta.contextWindow, 8192);
  assert.equal(meta.quantization, "Q4_K_M");
  assert.deepEqual(meta.languages, ["en", "hi"]);
  assert.ok(meta.memoryFootprintMiB >= 1);
  assert.equal(meta.ggufVersion, 3);
});

test("parseGgufMetadata: magic mismatch throws", () => {
  assert.throws(() => parseGgufMetadata(new Uint8Array([1, 2, 3, 4, 5, 6])));
});

test("pinned llama.cpp revision is documented", () => {
  assert.match(LLAMA_CPP_PINNED_REVISION, /^b\d+$/);
});
