# Teacher: tool pack

Education is a read/compute domain: the companion never mutates external systems. That keeps the whole pack auto-executable under the risk policy.

| Tool | Risk class | Purpose |
|---|---|---|
| `calculator` | `compute` | Arithmetic verification so the model never does mental math in high-stakes feedback |
| `expression-checker` | `compute` | Symbolic equivalence: is the learner's rearranged expression equal to the target |
| `plot-renderer` | `compute` | Render a function or dataset plot for visual explanation |
| `track-lookup` | `read` | Fetch node metadata (title, prerequisites, age floor) from the loaded task graph |
| `glossary` | `read` | Term definitions in the learner's language, sourced from the bundled corpus |
| `progress-report` | `read` | Summarize mastery posteriors for a facilitator, without raw session content |

## Policy

- No `write` or `critical` tools exist in this pack. If a deployment adds one (e.g. LMS grade write-back), it must route through approval per the tool contract, and grade write-back specifically is discouraged: the companion informs, humans grade.
- All tools must work offline against bundled data; a tool that needs the network degrades to `status: "error"` with a clear message rather than blocking the turn.
- Every invocation carries the session id in `invocationId` for the audit log, even though the pack is read-only. Consistent audit habits are cheaper than retrofitted ones.
