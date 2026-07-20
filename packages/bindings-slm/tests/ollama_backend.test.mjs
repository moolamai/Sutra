/**
 * Ollama backend unit tests (mocked fetch — no daemon required).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  createOllamaLlamaCppBackend,
  probeOllamaReachable,
  resolveOllamaConfigFromEnv,
} from "../dist/ollama_backend.js";

function mockFetch(handlers) {
  return async (url, init) => {
    const key = `${init?.method ?? "GET"} ${String(url)}`;
    const handler = handlers[key];
    if (!handler) {
      throw new Error(`unexpected fetch: ${key}`);
    }
    return handler(init);
  };
}

test("resolveOllamaConfigFromEnv reads model and base URL", () => {
  const cfg = resolveOllamaConfigFromEnv({
    SUTRA_OLLAMA_BASE_URL: "http://127.0.0.1:11434",
    SUTRA_OLLAMA_MODEL: "phi3:mini",
  });
  assert.equal(cfg.baseUrl, "http://127.0.0.1:11434");
  assert.equal(cfg.model, "phi3:mini");
});

test("probeOllamaReachable passes when model is listed", async () => {
  const result = await probeOllamaReachable({
    baseUrl: "http://127.0.0.1:11434",
    model: "qwen2.5:0.5b",
    fetchImpl: mockFetch({
      "GET http://127.0.0.1:11434/api/tags": async () => ({
        ok: true,
        async json() {
          return { models: [{ name: "qwen2.5:0.5b" }] };
        },
      }),
    }),
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.modelsListed, 1);
  }
});

test("probeOllamaReachable fails when model missing", async () => {
  const result = await probeOllamaReachable({
    baseUrl: "http://127.0.0.1:11434",
    model: "missing:tag",
    fetchImpl: mockFetch({
      "GET http://127.0.0.1:11434/api/tags": async () => ({
        ok: true,
        async json() {
          return { models: [{ name: "qwen2.5:0.5b" }] };
        },
      }),
    }),
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "model_missing");
  }
});

test("Ollama backend generate and embed against mocked API", async () => {
  const backend = createOllamaLlamaCppBackend({
    baseUrl: "http://127.0.0.1:11434",
    model: "qwen2.5:0.5b",
    fetchImpl: mockFetch({
      "POST http://127.0.0.1:11434/api/embeddings": async () => ({
        ok: true,
        async json() {
          return { embedding: [0.1, 0.2, 0.3, 0.4] };
        },
      }),
      "POST http://127.0.0.1:11434/api/generate": async () => ({
        ok: true,
        async json() {
          return {
            response: "Consistent hashing maps keys to nodes in a ring.",
            done: true,
          };
        },
      }),
    }),
  });

  const meta = {
    modelId: "fixture",
    contextWindow: 4096,
    quantization: "Q4_K_M",
    memoryFootprintMiB: 512,
    languages: ["en"],
    architecture: "llama",
    fileBytes: 1024,
    ggufVersion: 3,
  };
  const { handle, embedDim } = await backend.load("/fake/path.gguf", meta);
  assert.equal(embedDim, 4);
  assert.equal(backend.kind, "ollama");

  const generated = await backend.generate(handle, {
    prompt: "Explain consistent hashing simply.",
    maxTokens: 64,
    temperature: 0.2,
    deadlineMs: 30_000,
  });
  assert.equal(generated.deadlineHit, false);
  assert.match(generated.text, /Consistent hashing/);

  const vector = await backend.embed(handle, "probe");
  assert.equal(vector.length, 4);
  await backend.unload(handle);
});

test("Ollama backend falls back when embeddings API is disabled", async () => {
  const backend = createOllamaLlamaCppBackend({
    baseUrl: "http://127.0.0.1:11434",
    model: "qwen2.5:0.5b",
    fetchImpl: mockFetch({
      "POST http://127.0.0.1:11434/api/embeddings": async () => ({
        ok: false,
        status: 500,
        async text() {
          return "This server does not support embeddings. Start it with `--embeddings`";
        },
      }),
      "POST http://127.0.0.1:11434/api/generate": async () => ({
        ok: true,
        async json() {
          return { response: "Live reply without embeddings.", done: true };
        },
      }),
    }),
  });

  const meta = {
    modelId: "fixture",
    contextWindow: 4096,
    quantization: "Q4_K_M",
    memoryFootprintMiB: 512,
    languages: ["en"],
    architecture: "llama",
    fileBytes: 1024,
    ggufVersion: 3,
  };
  const { handle, embedDim } = await backend.load("/fake/path.gguf", meta);
  assert.equal(embedDim, 8);

  const generated = await backend.generate(handle, {
    prompt: "Hello",
    maxTokens: 32,
    temperature: 0.2,
    deadlineMs: 30_000,
  });
  assert.match(generated.text, /Live reply/);

  const vector = await backend.embed(handle, "probe");
  assert.equal(vector.length, 8);
  await backend.unload(handle);
});
