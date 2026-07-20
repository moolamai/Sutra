# custom-domain

How to create a **new domain adapter** without changing anything under `packages/`.

The provided domains (`teacher-basic`, `lawyer-basic`) configure the same `CognitiveCore` with pre-authored profiles. This example shows the full adapter surface from scratch, using agronomy as a stand-in domain (not yet specified under `domains/`).

## What you author

| Piece | In this example | In production |
|---|---|---|
| `AgentProfile` | `domainId`, charter, refusals, languages | Same; reviewed by a domain practitioner |
| Task graph | `TASK_GRAPH` rows in `main.mjs` | JSON/YAML loaded by the task router |
| Knowledge corpus | `makeKnowledge(...)` passages with `asOf` | Bundled-offline pack or self-hosted RAG index |
| Tool pack | Minimal `read` tool | Full pack with honest risk classes (see `tool-use/`) |
| Bindings | Shared mocks from `@moolam/contract-mocks` | Your vector store, model, speech, vision stacks |

## What you do not author

- The cognitive loop (`CognitiveCore`)
- Sync, memory kinds, CRDT merge, or runtime lifecycle
- Anything under `packages/`

## Run

```bash
pnpm custom-domain
```

## Next steps

1. Copy this directory as a starting point for your domain.
2. Add a full specification under `domains/your-domain/` (five files: README, interfaces, memory, tools, workflows). See [`domains/README.md`](../../domains/README.md).
3. Open a domain configuration PR; contract changes require an RFC, domain configuration does not.
