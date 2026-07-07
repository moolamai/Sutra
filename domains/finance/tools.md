# Finance: tool pack

| Tool | Risk class | Purpose |
|---|---|---|
| `market-data` | `read` | Prices, rates, and fundamentals with explicit as-of timestamps |
| `filings-search` | `read` | Retrieve and cite passages from the filings corpus |
| `research-library` | `read` | Internal notes and models for the covered entity |
| `ratio-calculator` | `compute` | Deterministic financial ratios and growth arithmetic |
| `scenario-runner` | `compute` | Run a sensitivity or scenario over a parameterized model |
| `screen-builder` | `compute` | Filter a universe on quantitative criteria |
| `note-saver` | `write` | Persist a research note draft to the analyst's workspace |
| `report-publisher` | `write` | Publish a finished note into the research distribution system |

## Policy

- Arithmetic never happens in the model: any reply containing computed figures must show a `ratio-calculator` or `scenario-runner` invocation in its trace, or the figures are demoted to estimates
- `market-data` responses embed their vintage; the reply renderer surfaces it next to every figure
- `report-publisher` requires analyst approval per invocation; compliance review hooks attach at the deployment layer, not in the platform
- There is deliberately no trade-execution tool; deployments that want one are building a different product and should read the risk-class section of the tool contract twice before proceeding
