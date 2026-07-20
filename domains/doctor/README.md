# Domain: Doctor

The clinical cognitive assistant: a decision-support companion for clinicians, community health workers, and rural practitioners. It surfaces guidelines, checks interactions, tracks case context across encounters, and works offline where connectivity fails, which is precisely where clinical support is scarcest.

## Who it serves

- Physicians who need guideline retrieval and differential support inside the encounter, not after it
- Community health workers operating protocol-driven care with sparse specialist backup
- Rural and mobile clinics with intermittent connectivity (the offline-first architecture is not optional here)

## What makes this domain distinctive

- The subject is a *case*, pseudonymized; the clinician is the user, the patient is never directly modeled by name
- Support, never diagnosis: the companion proposes considerations with evidence; the clinician decides
- Guideline currency is safety-critical: the knowledge contract's `asOf` field gates stale protocols
- The highest data-sensitivity domain: locality gating (`on-device` / `self-hosted` only) is mandatory, not advisory

## Safety posture

- Never diagnoses, never prescribes; presents ranked considerations with citations and confidence (charter refusals)
- Red-flag symptoms trigger an immediate escalation directive that bypasses normal routing
- Any tool that writes to a medical record is `critical` and requires clinician confirmation
- Unresolved constraints (a contraindication the engine could not verify) are always surfaced, never dropped; this is the reasoning contract doing exactly what it was written for

## Start here

- Formulary sketch (pack authoring source): [`data/formulary-sketch.md`](data/formulary-sketch.md) → built pack `knowledge-packs/doctor-formulary-sketch/`
- Interfaces to bind: [`interfaces.md`](interfaces.md)
- Memory semantics: [`memory.md`](memory.md)
- Tool pack: [`tools.md`](tools.md)
- Encounter workflows: [`workflows.md`](workflows.md)
