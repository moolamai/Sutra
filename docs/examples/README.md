# Examples (documentation guide)

The runnable examples live in the top-level [`examples/`](../../examples/README.md) directory. Each is a single small script against `@moolam/sdk`, designed to be read in one sitting and run with one command.

## Map

| Example | Demonstrates | Layer exercised |
|---|---|---|
| `teacher-basic/` | The loop configured as an education mentor | Core + contracts |
| `lawyer-basic/` | The same loop as a legal research companion; only configuration differs | Core + contracts |
| `offline-edge/` | A full turn with zero network: local SLM mock, in-memory storage | Edge host |
| `cloud-sync/` | Two replicas diverging offline and converging through CRDT merge | Sync protocol |
| `memory/` | Durable upsert, similarity search, kind-aware decay | Memory |
| `voice/` | A voice-only interaction loop with streaming transcription | Speech contract |
| `vision/` | A multimodal turn analyzing an image attachment | Vision contract |
| `tool-use/` | Risk classes and the approval gate for critical tools | Tool contract |
| `custom-domain/` | Author a new domain adapter from scratch (profile, task graph, corpus, tools) | Core + contracts |

## Running

```bash
pnpm install
pnpm --filter @moolam/examples run teacher-basic
pnpm --filter @moolam/examples run custom-domain
```

Every example runs offline with mock bindings by default; no API keys, no services. The shared mocks live in `examples/_shared/mocks.mjs` and double as a minimal reference for implementing each contract.

## Reading order

If you are new: `teacher-basic` then `lawyer-basic` (the pair proves domain independence), then `custom-domain` (how to roll your own), then `cloud-sync` (the protocol), then whichever contract you plan to implement.
