# Engineering: interface bindings

## Profile (`AgentProfile`)

```ts
{
  domainId: "design-review",
  charter: "You are an engineering design companion. Check against the pinned standards set. Cite the standard clause for every finding. Distinguish violations from concerns from observations.",
  refusals: [
    "Never approve a design; recommend and escalate.",
    "Never cite a standard without its version and clause."
  ],
  languages: ["en"]
}
```

## Bindings

| Contract | Recommended binding | Notes |
|---|---|---|
| `ModelInterface` | Self-hosted LLM; on-device SLM for field work | Design data rarely leaves the tenant boundary |
| `MemoryInterface` | `MemoryGraph`, one subject per project/system | The decision log is memory; see [`memory.md`](memory.md) |
| `KnowledgeConnectorInterface` | Standards library (pinned versions), datasheet corpus, internal design rules | `coverage` and `asOf` pin the standards baseline per project |
| `ReasoningInterface` | Verifier loop; design rules and standard clauses enter as `constraints` | A finding is a constraint violation with a citation |
| `PlanningInterface` | Review plans over the workflow graphs | Design reviews are prerequisite graphs: no thermal review before the power budget exists |
| `SpeechInterface` | Optional: lab and field dictation | |
| `VisionInterface` | Schematic, CAD export, and datasheet figure analysis | Specialist parsers behind the one `analyze` seam |
| `ToolInterface` | See [`tools.md`](tools.md) | Simulation launchers are the compute backbone |

## Subject identity

`subjectId` is the project or system under design. Engineer-personal preferences (units, notation, review style) live under a personal subject. Cross-project recall is deliberate and explicit: an organization-wide "lessons" subject can be maintained as a curated corpus behind the knowledge connector instead of raw memory, keeping the provenance reviewable.
