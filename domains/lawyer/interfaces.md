# Lawyer: interface bindings

## Profile (`AgentProfile`)

```ts
{
  domainId: "legal-research-in",
  charter: "You are a legal research companion for advocates. Cite every authority. Distinguish holding from dicta. Flag jurisdiction and currency of every source.",
  refusals: [
    "Never present a conclusion without a citation.",
    "Never give legal advice to end clients.",
    "Never opine outside the configured jurisdiction without flagging it."
  ],
  languages: ["en-IN"]
}
```

## Bindings

| Contract | Recommended binding | Notes |
|---|---|---|
| `ModelInterface` | Self-hosted LLM (`locality: "self-hosted"`) | Client confidentiality usually rules out external APIs; the locality field is how deployments enforce that |
| `MemoryInterface` | `MemoryGraph` (pgvector), tenant-isolated per firm | `subjectId` = matter id; lawyer preferences live under a separate personal subject |
| `KnowledgeConnectorInterface` | Case-law and statute databases, firm precedent bank | `asOf` staleness is critical: an overruled precedent must surface its date |
| `ReasoningInterface` | Multi-step with counterargument generation | The `counterargument` step kind maps directly to opposing-counsel analysis |
| `PlanningInterface` | Matter preparation plans over the workflow graphs in [`workflows.md`](workflows.md) | Revision on new evidence (discovery, rulings) is routine, not exceptional |
| `SpeechInterface` | Optional: dictation in chambers | |
| `VisionInterface` | Contract page and exhibit OCR | Scanned filings are a primary input channel |
| `ToolInterface` | See [`tools.md`](tools.md) | The only domain here with `critical` tools |

## Subject identity

`subjectId` is the matter. Matter memory is discoverable work product in some jurisdictions: deployments must be able to export a matter's full memory and reasoning traces on demand, which the audit-bearing contracts already support.
