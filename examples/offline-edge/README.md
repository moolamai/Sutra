# offline-edge

An `EdgeAgent` completing a full agent turn with zero connectivity.

**Field pilot:** device matrix, offline bundle, consent + friction telemetry (`markSynced`, sovereignty checklist) — [`docs/pilot/FIELD-PILOT-KIT.md`](../../docs/pilot/FIELD-PILOT-KIT.md).

## Mock SLM (default)

Local mock SLM, in-memory storage driver, no sync transport (permanently-offline sovereign mode). Demonstrates that the edge host is complete without a cloud.

```bash
pnpm offline-edge
```

## llama.cpp desktop path

Same offline-edge contract using `sutra-bindings-slm` `LlamaCppSlmRuntime` against the pinned desktop GGUF fixture, with network denied (B1 locality). Used by B6 certification (`proveLlamaCppOfflineDesktopTurn`).

```bash
pnpm offline-edge:llamacpp
```

## Live Ollama path (local demo)

Same stack with a **real** local Ollama model on loopback (not CI). Uses a **sub-1B** default (`qwen2.5:0.5b`) so laptop demos match mobile-feasible model class. Requires [Ollama](https://ollama.com/download) on loopback. **Windows:** `winget install Ollama.Ollama`, then open a new terminal.

```bash
ollama pull qwen2.5:0.5b
```

Override with `SUTRA_OLLAMA_MODEL` (e.g. `smollm2:360m`). Third-party egress must stay zero; only loopback calls to Ollama.

**Presentation demo** (screen recordings, walkthroughs):

```bash
pnpm offline-edge:live
```

Optional custom question: `SUTRA_DEMO_UTTERANCE="What is a CRDT?" pnpm offline-edge:live`

**Plain check** (automation / CI-style output):

```bash
pnpm offline-edge:live:check
```

Full guide: [`docs/demo/OFFLINE-LIVE.md`](../../docs/demo/OFFLINE-LIVE.md).

## Local STT (whisper.cpp-class)

Transcribe an Indic / code-switched fixture with `sutra-bindings-speech`, inject `SpeechInterface` into the edge CognitiveBindings set, then run CognitiveCore + EdgeAgent with network denied.

```bash
pnpm offline-edge:speech
```

## Local VLM

Analyze a committed CK-06 fixture image with `sutra-bindings-vision`, inject `VisionInterface` into the edge CognitiveBindings set, then run CognitiveCore (attachment) + EdgeAgent with network denied.

```bash
pnpm offline-edge:vision
```
