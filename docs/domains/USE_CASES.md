# Use Cases - Cross-Industry Catalogue

**Moolam Open Cognitive Infrastructure · Indian Sovereign AI Initiative**

The domain changes; the cognitive primitives - **memory, planning, reasoning, reflection, simulation, communication, tool use** - stay largely the same. This catalogue maps industries to companion products that developers and companies can build on Sutra, the modalities each demands, and the contracts each exercises.

Every companion below is a *configuration* of the same contracts (`@moolam/contracts`), not a new codebase. That is the platform thesis: build the user-facing 10%, inherit the cognitive 90%. Five of these rows have full specifications under [`domains/`](../../domains/README.md).

---

## Modality classes

| Class | Description | Typical hardware |
|---|---|---|
| **T** - Text | Chat/document interface | Any |
| **V** - Voice-only | Speech in/out, no screen dependency | Feature phones, IVR, earbuds, vehicles |
| **VV** - Voice + Visual | Speech plus camera/screen understanding | Smartphones, tablets, kiosks |

Voice-only (**V**) deserves emphasis for the sovereign deployment context: it reaches users regardless of literacy, language script, or device cost, in any of India's major languages via the `SpeechInterface`'s first-class Indic support.

---

## 1. Education (specified in [`domains/teacher/`](../../domains/teacher/README.md))

| Companion | Modality | Primary users | Contracts stressed | Knowledge connectors |
|---|---|---|---|---|
| School-subject mentor (the Sutra reference) | T / V / VV | Students 6-18 | Memory (mastery), Planning (prerequisite loop-back), Speech | Track packs (bundled-offline) |
| Competitive-exam companion (JEE/NEET/UPSC) | T / VV | Aspirants | Planning (syllabus graphs), Reasoning (worked solutions), Memory (weak-topic tracking) | Question banks, past papers |
| Interview & system-design coach | T / V | Engineers | Reasoning (design critique), Simulation via Tools (mock scenarios) | Engineering corpora |
| Language-learning conversation partner | V / VV | All ages | Speech (pronunciation confidence), Memory (error patterns) | Graded readers, phrase corpora |
| Facilitator's assistant (session prep, progress insight) | T | Facilitators | Tools (rubric scoring), Knowledge (track standards) | Board syllabi, textbook indexes |

## 2. Law (specified in [`domains/lawyer/`](../../domains/lawyer/README.md))

| Companion | Modality | Primary users | Contracts stressed | Knowledge connectors |
|---|---|---|---|---|
| Legal-research companion | T | Advocates, firms | Reasoning (argument construction with citations), Knowledge (case law) | Statutes, ECLI/Indian Kanoon-class indexes |
| Contract-review companion | T / VV | In-house counsel | Vision (scanned documents), Reasoning (clause risk), Tools (clause libraries) | Precedent clause banks |
| Litigation-prep companion | T | Trial teams | Planning (case-preparation graphs), Memory (matter history), Simulation (opposing-argument drills) | Court filings, dockets |
| Citizen legal-aid guide | V | General public | Speech (Indic languages), strict Refusals (no unauthorized practice) | Plain-language statute guides |

## 3. Medicine (specified in [`domains/doctor/`](../../domains/doctor/README.md))

| Companion | Modality | Primary users | Contracts stressed | Knowledge connectors |
|---|---|---|---|---|
| Clinical decision-support companion | T / VV | Physicians | Reasoning (differential with mandatory trace), Knowledge (guidelines), Tools (interaction checkers) | Formularies, clinical guidelines, FHIR/EHR |
| Ward-round documentation companion | V | Clinicians | Speech (ambient transcription), Memory (case threads) | EHR connectors |
| Radiology/second-read assistant | VV | Radiologists | Vision (specialist model binding), Reasoning (finding correlation) | PACS/DICOM connectors |
| ASHA/community-health-worker companion | V / VV | Field health workers | Speech (Indic, offline), Planning (screening protocols), edge-first deployment | National protocol packs (bundled-offline) |
| Medical-student case-based mentor | T / VV | Students, residents | Planning (task graphs), Simulation (virtual patients via Tools) | Textbooks, guideline corpora |

*All clinical configurations are decision **support**: the `AgentProfile.refusals` boundary and the mandatory reasoning trace exist precisely so a licensed human stays the decision-maker.*

## 4. Finance (specified in [`domains/finance/`](../../domains/finance/README.md))

| Companion | Modality | Primary users | Contracts stressed | Knowledge connectors |
|---|---|---|---|---|
| Analyst companion (filings, earnings, screens) | T | Analysts, PMs | Reasoning (thesis construction), Tools (market data, models), Knowledge (filings) | Exchange feeds, XBRL filings |
| Compliance & audit companion | T | Compliance teams | Reasoning (rule application with trace), Tools (transaction queries, risk-classed "write" actions) | Regulatory rulebooks |
| SME bookkeeping & GST companion | T / V | Small businesses | Tools (ledger ops), Speech (voice entry), Memory (business context) | Tax-rule packs |
| Financial-literacy companion | V | New savers/investors | Speech (Indic), strict Refusals (no unlicensed advice) | Investor-education corpora |

## 5. Engineering (specified in [`domains/engineering/`](../../domains/engineering/README.md))

| Companion | Modality | Primary users | Contracts stressed | Knowledge connectors |
|---|---|---|---|---|
| Design-review companion | T / VV | Design teams | Vision (schematics/CAD), Reasoning (standards conformance), Tools (validators, simulators) | Standards bodies (IS/IEC/ISO), datasheets |
| Site & safety inspection companion | VV / V | Field engineers | Vision (defect detection), Planning (inspection protocols), offline edge operation | Code-of-practice packs |
| Incident/postmortem companion | T | SRE/ops teams | Memory (system history), Reasoning (causal analysis), Tools (telemetry queries) | Runbooks, observability APIs |
| Manufacturing line companion | V / VV | Operators | Speech (hands-free), Tools (MES/SCADA, risk-classed) | SOPs, machine manuals |

## 6. Science & Research

| Companion | Modality | Primary users | Contracts stressed | Knowledge connectors |
|---|---|---|---|---|
| Literature-synthesis companion | T | Researchers | Knowledge (citation-mandatory retrieval), Reasoning (claim reconciliation), Memory (project corpus) | OpenAlex/PubMed-class indexes |
| Experiment-design companion | T | Lab scientists | Planning (protocol graphs), Simulation (power analysis via Tools) | Method repositories |
| Grant & paper writing companion | T | Academics | Memory (prior work), Reasoning (argument structure) | Funder guidelines |

## 7. Agriculture & Rural Livelihoods

| Companion | Modality | Primary users | Contracts stressed | Knowledge connectors |
|---|---|---|---|---|
| Agronomy companion | V / VV | Farmers | Vision (pest/disease photos), Speech (Indic, offline-first), Planning (crop calendars) | Agri-university advisories (bundled-offline) |
| Market & scheme navigator | V | Farmers, FPOs | Tools (mandi prices), Knowledge (government schemes) | eNAM/scheme APIs |

## 8. Governance & Public Service

| Companion | Modality | Primary users | Contracts stressed | Knowledge connectors |
|---|---|---|---|---|
| Citizen-services navigator | V / T | General public | Speech (Indic), Knowledge (procedure guides), strict data-locality | Department procedure packs |
| Case-worker companion | T | Government staff | Memory (case threads), Planning (workflow protocols), Tools (registry queries, audited) | Departmental systems |

## 9. Accessibility & Care

| Companion | Modality | Primary users | Contracts stressed | Knowledge connectors |
|---|---|---|---|---|
| Visual-assistance companion | V + camera | Blind/low-vision users | Vision (scene description), Speech (always-on) | - |
| Elder-care daily companion | V | Seniors, caregivers | Memory (routines, medication schedules), Tools (reminders, alerts - "critical" risk class) | Care-plan packs |
| Skilling & vocational coach | VV | ITI students, workers | Vision (technique feedback), Planning (skill ladders) | NSQF tracks |

---

## Why one platform can serve all of these

Every row above decomposes into the same loop `CognitiveCore` already implements:

```
perceive (Speech/Vision) → recall (Memory) → retrieve (Knowledge)
→ reason (Reasoning) → plan/act (Planning + Tools) → respond (Model/Speech)
→ reflect (Memory)
```

What actually differs per row - and what an integrator authors - is the **configuration surface**:

1. **`AgentProfile`** - charter, refusals (scope of practice), languages.
2. **Contract bindings** - which memory store, which model(s) at which locality, which speech/vision stacks.
3. **Knowledge connectors** - the authoritative corpora with citations.
4. **Tool registry** - domain actions with honest risk classes.
5. **Task graphs** - the domain's prerequisite/protocol structure for the planner.

That is the 90% acceleration claim, made concrete: items 1-5 are declarative domain knowledge; the cognitive machinery, offline sync, audit trails, and multimodal plumbing are inherited.

## Regulated-domain posture (law, medicine, finance)

These domains are the strongest argument for Sutra's design choices, not exceptions to them:

- **Mandatory reasoning traces** (`ReasoningInterface`) - conclusions without auditable steps are contract violations.
- **Citation-bearing knowledge** (`KnowledgeConnectorInterface`) - uncited passages are inadmissible to reasoning.
- **Risk-classed tools** (`ToolInterface`) - "write" and "critical" actions require policy/human approval with write-ahead audit.
- **Data locality** (`ModelDescriptor.locality`, `KnowledgeSourceDescriptor.locality`) - deployments can enforce that regulated data classes never leave self-hosted or on-device boundaries.
- **Refusal boundaries** (`AgentProfile.refusals`) - scope-of-practice limits are configuration, checked by the reasoning layer, not prompt-engineering hope.
