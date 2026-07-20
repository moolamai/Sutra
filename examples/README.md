# Examples

Small, runnable demonstrations of the infrastructure. Every example runs offline with zero external services: models, speech, and vision are deterministic mocks so you can study the *architecture* without API keys or downloads. Swap any mock for a real binding and the surrounding code does not change; that is the point of the contracts.

## Running

```bash
pnpm install && pnpm build     # from the repository root
cd examples
pnpm teacher-basic             # or any example name below
pnpm test                      # runs every example
```

| Example | What it demonstrates |
|---|---|
| `teacher-basic/` | The cognitive core configured as an education mentor: one `CognitiveCore`, education-domain profile and knowledge |
| `lawyer-basic/` | The *same* core configured as a legal research companion: only the domain configuration changes |
| `offline-edge/` | `EdgeAgent` running a full turn fully on-device with a local mock SLM and in-memory storage |
| `cloud-sync/` | Two device replicas diverging offline, then converging through a real CRDT merge |
| `memory/` | `LocalVectorDb`: durable writes, similarity search, kind-aware decay |
| `voice/` | Voice-only loop: streaming transcription into a core turn, reply back through synthesis |
| `vision/` | Multimodal turn: local VLM (`sutra-bindings-vision`) analyzes a committed CK-06 fixture and folds it into reasoning |
| `tool-use/` | Tool registry with risk classes: auto-executed reads vs denied critical actions |
| `custom-domain/` | Author a new domain adapter from scratch: profile, task graph, corpus, tools, bindings (no `packages/` changes) |

## Shared mocks

Examples import reference bindings from `@moolam/contract-mocks` (the supported
in-memory floor that itself passes the mock conformance gate). Use
`makeMemory`, `makeModel`, `makeReasoning`, `makeKnowledge`, `makePlanning`,
`makeNoTools`, and `embed` — swap any for a production binding without changing
surrounding example code.
