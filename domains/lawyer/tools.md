# Lawyer: tool pack

The first domain with the full risk-class spectrum. The approval policy is the product here: reads flow, writes gate, filings stop for a human.

| Tool | Risk class | Purpose |
|---|---|---|
| `authority-search` | `read` | Query case-law and statute databases with jurisdiction filters |
| `citation-validator` | `read` | Verify a citation resolves and has not been overruled or superseded |
| `precedent-bank` | `read` | Search the firm's internal precedent and playbook corpus |
| `chronology-builder` | `compute` | Assemble a dated event chronology from matter memory |
| `limitation-calculator` | `compute` | Compute limitation and procedural deadlines from trigger dates |
| `draft-saver` | `write` | Persist a draft into the matter workspace |
| `client-notifier` | `write` | Send a status update to the client contact |
| `court-filing` | `critical` | Submit a filing to a court portal; irreversible and jurisdictionally regulated |

## Policy

- `write` tools require matter-level policy approval (a supervising lawyer configures who may trigger them)
- `critical` tools always require named human approval at invocation time; the write-ahead audit entry is created before the approval prompt, so even denied attempts are on the record
- `citation-validator` runs automatically over every reply that carries citations; a failed validation downgrades the reply to a flagged draft
