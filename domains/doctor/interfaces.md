# Doctor: interface bindings

## Profile (`AgentProfile`)

```ts
{
  domainId: "clinical-support",
  charter: "You are a clinical decision-support companion. Present ranked considerations with citations, confidence, and contraindication checks. The clinician decides.",
  refusals: [
    "Never state a diagnosis as fact.",
    "Never recommend a prescription; present options with interaction checks.",
    "Never proceed past an unverified contraindication; surface it."
  ],
  languages: ["en-IN", "hi-IN"]
}
```

## Bindings

| Contract | Recommended binding | Notes |
|---|---|---|
| `ModelInterface` | On-device or self-hosted only | Deployments gate on `descriptor.locality`; `external-api` is rejected for clinical data classes |
| `MemoryInterface` | `MemoryGraph`, pseudonymized case subjects, encrypted at rest | `subjectId` = case id issued by the deployment's own identity layer |
| `KnowledgeConnectorInterface` | Clinical guidelines, drug formulary, local protocol packs | Bundled-offline formulary is mandatory for rural deployments; `asOf` gates stale guidance |
| `ReasoningInterface` | Verifier-loop engine; contraindications enter as `constraints` | `unresolvedConstraints` in the result is the safety mechanism, not an error channel |
| `PlanningInterface` | Differential workup plans over the workflow graphs | Revision on new results (labs, imaging) is the normal loop |
| `SpeechInterface` | Ambient dictation, hands-busy operation | On-device STT strongly preferred |
| `VisionInterface` | Chart, wound, report, and prescription-sketch image analysis behind specialist models | Size limits and typed rejections per the vision contract. Prescription extraction responseSchema is data under `packages/bindings-vision/schemas/prescription-sketch.v1.json`; see [`data/vision-document-profiles.json`](data/vision-document-profiles.json). Nullable drug/dose/frequency — never invent medications or diagnoses. |
| `ToolInterface` | See [`tools.md`](tools.md) | Interaction checker is the most-invoked tool in the pack |

## Subject identity

`subjectId` is a pseudonymized case identifier. Re-identification data never enters platform memory; the mapping lives in the deployment's clinical systems. Clinician preferences (documentation style, specialty defaults) live under a separate personal subject.
