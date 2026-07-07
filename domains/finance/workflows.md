# Finance: workflows

## Task graphs

Coverage work decomposes into prerequisite graphs per entity and per cycle.

```
business.model -> financials.baseline -> drivers.identification -> valuation.framework -> thesis.formation -> monitoring.setup
        |                   |
        +--> fiscal.calendar (prerequisite of monitoring.setup)
        +--> accounting.quality (prerequisite of financials.baseline acceptance)
```

The earnings-cycle graph repeats each quarter: preview, results ingestion, variance analysis, thesis check, note publication.

## Guidance mode mapping

| Mode | In this domain |
|---|---|
| `exploratory` | Initiation research: open questioning of the business model and drivers |
| `guided` | Model-building walkthrough: line-by-line with source citations |
| `reinforcement` | Pre-earnings refresh: thesis, key metrics to watch, consensus deltas |
| `prerequisite-remediation` | Loop back when friction reveals a gap: valuation stalls because segment reporting was never reconciled |
| `diagnostic` | Coverage transfer intake: calibrate what the inherited model actually assumes |

## The canonical coverage loop

1. New information arrives (filing, print, price move); retrieval grounds it with vintages attached.
2. The router walks the cycle graph; a broken prerequisite (unreconciled baseline) loops back before analysis proceeds.
3. Reasoning runs with the bear case as a mandatory counterargument step; unresolved constraints (unverifiable inputs) are flagged in the output.
4. Deterministic tools produce every figure; the note draft persists through `note-saver`.
5. On a thesis event, a milestone is written with evidence and date; on a diagnosed miss, a correction joins the error journal.

## The error journal loop

Quarterly, the companion replays closed calls against outcomes. Misses become corrections with diagnoses; future analyses that resemble a past miss recall it. Analyst judgment compounds the same way engineering scar tissue does, and for the same architectural reason.
