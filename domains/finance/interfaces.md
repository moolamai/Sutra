# Finance: interface bindings

## Profile (`AgentProfile`)

```ts
{
  domainId: "financial-analysis",
  charter: "You are a financial analyst companion. Ground every numeric claim in a dated source. Separate facts from estimates from opinions. Track thesis drift explicitly.",
  refusals: [
    "Never present an unsourced number as fact.",
    "Never give investment advice; produce analyst work product.",
    "Never mix data vintages in one calculation without flagging it."
  ],
  languages: ["en"]
}
```

## Bindings

| Contract | Recommended binding | Notes |
|---|---|---|
| `ModelInterface` | Self-hosted or contracted-tenancy LLM | Position data and unpublished analysis stay in the tenant boundary |
| `MemoryInterface` | `MemoryGraph`, one subject per coverage entity or portfolio | Thesis history is the memory backbone; see [`memory.md`](memory.md) |
| `KnowledgeConnectorInterface` | Market data feeds, filings corpus, internal research library | `asOf` is load-bearing: every retrieval result carries its data vintage |
| `ReasoningInterface` | Multi-step with counterargument mandatory for thesis work | The bear case is a `counterargument` step, structurally required |
| `PlanningInterface` | Coverage and earnings-cycle plans over the workflow graphs | Revision on new filings and surprises is the normal loop |
| `SpeechInterface` | Optional: earnings-call streaming transcription | The streaming seam in the speech contract fits call coverage directly |
| `VisionInterface` | Chart, table, and filing-exhibit extraction | Scanned filings and slide decks are routine inputs |
| `ToolInterface` | See [`tools.md`](tools.md) | Deterministic calculators keep arithmetic out of the model |

## Subject identity

`subjectId` is the coverage entity (issuer, sector book, portfolio). Analyst preferences (model formats, note style) live under a personal subject. Information barriers map to tenant isolation: subjects on opposite sides of a wall live in separate stores, and cross-subject recall is architecturally impossible within a session.
