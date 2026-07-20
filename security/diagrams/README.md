# Threat-model data-flow diagrams

Mermaid sources for the STRIDE threat model (`../THREAT-MODEL.md`). These diagrams name trust boundaries and data classifications (metadata vs content) for the four P7 surfaces:

| Diagram | Surface | Source |
|---------|---------|--------|
| Edge turn loop | On-device `CognitiveCore.turn` via `EdgeAgent` | [`edge-turn-loop.mmd`](./edge-turn-loop.mmd) |
| Cloud agent / sync host | FastAPI auth, `AgentRuntime`, `SyncService` | [`cloud-agent-sync-path.mmd`](./cloud-agent-sync-path.mmd) |
| Sync wire | `SyncRequest` / `SyncResponse` over HTTPS | [`sync-wire.mmd`](./sync-wire.mmd) |
| Tool sandbox seam | Envelope parse → policy → audit → invoke | [`tool-sandbox-seam.mmd`](./tool-sandbox-seam.mmd) |

Render in GitHub, VS Code (Mermaid preview), or any Mermaid-capable viewer. Architecture figures for product documentation remain under [`docs/architecture/diagrams/`](../../docs/architecture/diagrams/README.md).
