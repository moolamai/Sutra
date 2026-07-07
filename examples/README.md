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
| `vision/` | Multimodal turn: a visual attachment analyzed and folded into reasoning |
| `tool-use/` | Tool registry with risk classes: auto-executed reads vs denied critical actions |
| `custom-domain/` | Author a new domain adapter from scratch: profile, task graph, corpus, tools, bindings (no `packages/` changes) |

## Shared mocks

`_shared/mocks.mjs` contains the deterministic mock bindings (model, reasoning, memory, knowledge, planning, tools) reused across examples. Each mock honors its contract obligations; they are legitimate minimal implementations, not stubs that lie.
