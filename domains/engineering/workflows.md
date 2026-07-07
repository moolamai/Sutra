# Engineering: workflows

## Task graphs

A design review is a prerequisite graph; skipping a foundation invalidates everything downstream.

```
requirements.baseline -> architecture.review -> interfaces.review -> detailed.design -> verification.plan
          |                        |
          +--> standards.selection (prerequisite of every review stage)
          +--> budgets.power/mass/thermal (prerequisite of detailed.design)
```

## Guidance mode mapping

| Mode | In this domain |
|---|---|
| `exploratory` | Trade-study dialogue: surface alternatives, probe requirements |
| `guided` | Checklist-driven review walkthrough against the pinned standards |
| `reinforcement` | Pre-milestone refresh: open findings, unverified constraints, stale budgets |
| `prerequisite-remediation` | Loop back when friction reveals a missing foundation: detailed design stalls because the power budget was never closed |
| `diagnostic` | Project onboarding: calibrate what exists, what is assumed, what is undocumented |

## The canonical review loop

1. The engineer submits a design fragment (text, schematic image, CAD export).
2. Vision and knowledge retrieval ground the fragment against datasheets and the standards set.
3. Reasoning checks constraints; findings carry clause citations, concerns carry rationale, and anything unverifiable lands in `unresolvedConstraints`.
4. The router walks the review graph, looping back to missing prerequisites before deeper review continues.
5. Accepted findings persist through `design-annotator`; decisions write milestones to the log.

## Institutional memory loop

When a fielded failure is diagnosed, the root cause is written as a `correction` linked to the original decision milestone. From then on, any design fragment that resembles the failure pattern recalls it. This loop is the domain's reason to exist.
