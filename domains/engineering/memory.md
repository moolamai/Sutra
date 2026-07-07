# Engineering: memory semantics

## Kind mapping

| Generic kind | In this domain | Decay |
|---|---|---|
| `correction` | A design mistake the organization already paid for: "this connector series fails under vibration", "rev B grounding scheme caused EMI failures" | Never decays; this is institutional scar tissue and the domain's core value |
| `milestone` | A design decision with rationale: architecture chosen, trade study concluded, review passed | Never decays; the decision log |
| `preference` | Engineer and team conventions: units, notation, preferred vendors, review formats | Never decays |
| `episodic` | Working session traces: alternatives explored, calculations run, dead ends | 30-day half-life; long enough to survive a design iteration |
| `semantic` | Project facts: requirements baseline, standards set and versions, interfaces, budgets (mass, power, thermal) | Never decays while the project is active |

## Retrieval policy

Recall is project-scoped, corrections first. The highest-value retrieval pattern is associative: the current design fragment resembles a past failure. This is where graph-capable memory stores (the `associate` and `relatedIds` seams in the contract) earn their keep: corrections link to the decisions that caused them.

## Decision log discipline

Every accepted recommendation writes a `milestone` with the rationale text and the reasoning trace reference. Six months later, "why did we choose the linear regulator" is a recall query, not an archaeology project.
