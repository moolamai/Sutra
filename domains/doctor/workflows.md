# Doctor: workflows

## Task graphs

A differential workup is a prerequisite graph: you do not commit to a working assessment before the history is taken, and you do not order confirmatory tests before the differential is framed.

```
history.intake -> examination.findings -> differential.framing -> investigations.plan -> assessment.working -> management.options
        |                                        |
        +--> redflag.screen (prerequisite of everything; failure escalates immediately)
        +--> allergies.medications (prerequisite of management.options)
```

## Guidance mode mapping

| Mode | In this domain |
|---|---|
| `exploratory` | History-taking dialogue: open questions, hypothesis-free listening |
| `guided` | Protocol walkthrough for community health workers: step-by-step with checks |
| `reinforcement` | Case refresh before a follow-up: prior findings, pending results, open questions |
| `prerequisite-remediation` | Loop back when friction reveals a gap: management discussion stalls because allergies were never recorded |
| `diagnostic` | New case calibration: what is known, what is assumed, what must be verified |

## The canonical encounter loop

1. The clinician describes the presentation (voice or text); red-flag screening runs first, every turn.
2. The router walks the workup graph; missing prerequisites (no allergy record, no vitals) loop the session back before considerations are offered.
3. Reasoning runs with contraindications as constraints; anything unverifiable is surfaced, never swallowed.
4. Considerations are presented ranked, cited, and dated; the clinician decides and documents in the system of record.
5. Offline encounters sync when connectivity returns; the case memory converges across the clinic's devices.

## Escalation

A positive red-flag screen emits an escalation directive that overrides the current mode and concept: the guidance becomes "refer or escalate now", and the event is written as a case milestone.
