# Doctor: tool pack

| Tool | Risk class | Purpose |
|---|---|---|
| `guideline-lookup` | `read` | Retrieve the current protocol for a presentation, with `asOf` currency |
| `formulary-search` | `read` | Drug information from the bundled-offline formulary |
| `interaction-checker` | `compute` | Check a medication set for interactions and contraindications |
| `dose-calculator` | `compute` | Weight/age-adjusted dosing computation |
| `risk-scorer` | `compute` | Standard clinical scores (e.g. CURB-65 class scores) from structured inputs |
| `referral-drafter` | `write` | Draft a referral letter into the clinician's queue for review |
| `record-writer` | `critical` | Write an entry to the medical record system |

## Policy

- `interaction-checker` runs automatically whenever a medication is mentioned in a consideration; its failures become reasoning `constraints`, so an uncheckable interaction lands in `unresolvedConstraints` and is surfaced
- `referral-drafter` output is always a draft; nothing leaves the clinician's queue without their action
- `record-writer` requires named clinician approval per invocation with write-ahead audit; there is no batch mode by design
- Every tool must work offline against bundled data where its risk class allows; `record-writer` queues when offline and requires re-approval at flush
