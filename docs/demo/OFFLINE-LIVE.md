# Offline live demo (Ollama)

Run a **real** local model through the same EdgeAgent / CognitiveCore stack used in certification — without cloud API keys.

The default model is **sub-1B** (`qwen2.5:0.5b`) so desktop demos match what mid-range **mobile** targets can carry (the repo certifies ONNX `android-mid` with small int-quant fixtures, not multi‑GB LLMs).

## What this proves

- Full agent turn (`EdgeAgent` + `LlamaCppSlmRuntime`) with a **live** Ollama model on loopback
- `servedLocally: true` and offline sync mode (`offline-mode`, no transport)
- **Zero third-party egress** — only loopback calls to your Ollama daemon
- GGUF metadata still comes from the pinned desktop fixture (truthful model card); inference uses Ollama

## Prerequisites

1. **Ollama** installed and running.

**Windows (PowerShell):**

```powershell
winget install Ollama.Ollama
```

Close and reopen the terminal after install. Ollama usually runs as a background app (tray icon). Or download from [ollama.com/download](https://ollama.com/download).

Verify:

```powershell
ollama --version
```

2. Pull the default small model (~0.5B, ~400–600 MiB weights):

```bash
ollama pull qwen2.5:0.5b
```

**RAM (desktop demo):** ~4 GB system minimum, **8 GB** comfortable. Much lighter than 3B-class models.

3. Monorepo built:

```bash
pnpm install && pnpm build
```

## Run

From repo root:

```bash
pnpm --filter @moolam/examples offline-edge:live
```

Or from `examples/`:

```bash
pnpm offline-edge:live
```

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `SUTRA_OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Ollama daemon URL (loopback only) |
| `SUTRA_OLLAMA_MODEL` | `qwen2.5:0.5b` | Model tag from `ollama list` |

### Other mobile-class options

| Model | Size | Notes |
|-------|------|--------|
| `qwen2.5:0.5b` | ~0.5B | **Default** — good quality/size for demos |
| `smollm2:360m` | ~360M | Smaller; set `SUTRA_OLLAMA_MODEL=smollm2:360m` |
| `gemma2:2b` | 2B | Avoid on low-RAM machines; not mobile-class |

On-device production uses **ONNX / AICore / MLX** bindings (`android-mid`, `apple-silicon`), not Ollama — Ollama is for **local developer demos** on loopback with the same agent stack.

## CI vs live

| Script | Backend | When |
|--------|---------|------|
| `offline-edge` | Mock SLM | Always; zero deps |
| `offline-edge:llamacpp` | In-process stand-in | CI / certification; zero egress |
| `offline-edge:live` | Ollama on loopback | **Local awe demo**; requires Ollama |

The in-process stand-in intentionally returns deterministic text (`ll:…`) so CI stays fast and network-free. The live script rejects that pattern so you know Ollama actually ran.

## Recording the README clip

1. Start Ollama and `ollama pull qwen2.5:0.5b`
2. Disable Wi‑Fi (optional but recommended for the story)
3. Run `pnpm --filter @moolam/examples offline-edge:live`
4. Show `third-party egress: 0` and a real reply preview in the terminal

## Architecture note

This does not bypass Sutra layers. The example imports `runOfflineEdgeLiveTurn` from `sutra-bindings-slm`, which injects `createOllamaLlamaCppBackend` at the existing `LlamaCppNativeBackend` seam — the same extension point reserved for native llama.cpp FFI in production.
