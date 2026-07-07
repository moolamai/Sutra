# Engineering: tool pack

| Tool | Risk class | Purpose |
|---|---|---|
| `standards-lookup` | `read` | Retrieve a clause from the pinned standards set, with version |
| `datasheet-search` | `read` | Component parameters from the datasheet corpus |
| `decision-log` | `read` | Query past design decisions and their rationale |
| `unit-checker` | `compute` | Dimensional analysis over expressions and budgets |
| `budget-calculator` | `compute` | Mass/power/thermal budget rollups from the current design state |
| `simulation-launcher` | `compute` | Run a bounded simulation job (SPICE, FEA preflight) and return results |
| `design-annotator` | `write` | Attach findings to design artifacts in the repository |
| `change-order` | `critical` | Raise an engineering change order in the PLM system |

## Policy

- `simulation-launcher` enforces the tool deadline strictly: a hung solver returns a timeout result and the turn proceeds without it
- `design-annotator` writes are attributed to the companion and marked as findings, never as approvals
- `change-order` requires named engineer approval and carries the full reasoning trace reference in its audit entry
- Findings without a standard citation are demoted to observations by policy, mirroring the citation rule in reasoning
