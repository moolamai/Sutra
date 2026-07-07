# Doctor: memory semantics

## Kind mapping

| Generic kind | In this domain | Decay |
|---|---|---|
| `correction` | A ruled-out consideration or corrected pattern: "this presentation was not cardiac", "allergy to penicillin recorded" | Never decays; resurfacing ruled-out paths wastes encounters, missing an allergy is worse |
| `milestone` | A case decision: working assessment set, referral made, treatment response observed | Never decays for the case lifetime |
| `preference` | Clinician style: documentation format, guideline set preference, escalation thresholds | Never decays; personal subject |
| `episodic` | Encounter traces: complaints, observations, considerations discussed | 30-day half-life; the durable clinical record lives in the EHR, not here |
| `semantic` | Case context: age band, chronic conditions, current medications | Never decays while the case is open |

## Retrieval policy

Recall is case-scoped. Corrections (allergies, ruled-out paths) rank above everything. Episodic encounter traces bridge between visits but are explicitly NOT the medical record: the record of care is the clinician's documentation in the system of record.

## Data protection constraints

- Pseudonymized subjects only; no names, no identifiers in memory text (deployments enforce at ingestion)
- Encryption at rest; tenant isolation per facility
- Patient-rights erasure maps to bulk `forget` over the case subject plus state-document deletion
- Sync carries the same pseudonymized ids; the identity mapping never syncs
