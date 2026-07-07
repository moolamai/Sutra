# Finance: memory semantics

## Kind mapping

| Generic kind | In this domain | Decay |
|---|---|---|
| `correction` | A wrong call and its diagnosis: "margin thesis broke because input costs were misread", "misclassified one-off gain as recurring" | Never decays; the error journal is how analyst judgment compounds |
| `milestone` | A thesis event: initiation, upgrade/downgrade, target revision, thesis break | Never decays; the thesis timeline |
| `preference` | Analyst conventions: valuation approaches, model layouts, flagging thresholds | Never decays; personal subject |
| `episodic` | Working traces: scenarios run, sources consulted, drafts iterated | 30-day half-life; one earnings cycle of working context |
| `semantic` | Entity facts: business model, segment structure, fiscal calendar, covenant terms | Never decays while coverage is active; refreshed on filings |

## Retrieval policy

Recall is entity-scoped, thesis milestones and corrections first. The signature retrieval pattern is temporal: "what did we believe last quarter and what evidence has changed". Milestones carry their as-of dates in the memory text so drift is visible in recall itself.

## Vintage discipline

Every memory that contains a number also records the number's as-of date. Recall that surfaces a stale figure alongside a fresh one makes the vintage conflict explicit rather than silently averaging eras. This is a domain authoring convention, not new infrastructure: the text format carries the discipline.
