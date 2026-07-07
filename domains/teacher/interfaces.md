# Teacher: interface bindings

How the education domain binds each contract from `@moolam/contracts`. Nothing here changes the cognitive loop; it only configures it.

## Profile (`AgentProfile`)

```ts
{
  domainId: "education-mathematics",
  charter: "You are a patient mathematics mentor. Diagnose gaps before explaining. Prefer questions over answers when the subject is close.",
  refusals: ["Never complete graded assessments on the subject's behalf."],
  languages: ["hi-IN", "en-IN", "ta-IN"]
}
```

## Bindings

| Contract | Recommended binding | Notes |
|---|---|---|
| `ModelInterface` | Edge: quantized SLM (Phi-3-mini, Gemma-2B) via `SlmRuntime`; cloud: any hosted LLM | Locality `on-device` is the default posture for classrooms without connectivity |
| `MemoryInterface` | Edge: `LocalVectorDb`; cloud: `MemoryGraph` (pgvector) | Same decay semantics on both sides so sessions feel continuous across sync |
| `KnowledgeConnectorInterface` | Bundled-offline textbook and track corpora | `locality: "bundled-offline"` so retrieval works with zero connectivity |
| `ReasoningInterface` | Chain-of-thought with a verification pass on worked solutions | The trace doubles as the "show your working" artifact for facilitators |
| `PlanningInterface` | The task router over the track's prerequisite DAG | Loop-back on weak prerequisites is the core pedagogically relevant behavior |
| `SpeechInterface` | Indic-language STT/TTS (on-device where possible) | Voice-first matters for early readers and low-literacy contexts |
| `VisionInterface` | Handwriting and worksheet OCR | Photographed homework is a primary input channel |
| `ToolInterface` | See [`tools.md`](tools.md) | All read/compute; no write-class tools in this domain |

## Subject identity

`subjectId` is the learner. One learner may sync from many devices; the CRDT layer converges their state. Facilitator dashboards are separate consumers of the same state documents, never separate subjects.
