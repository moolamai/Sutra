# Lawyer: memory semantics

## Kind mapping

| Generic kind | In this domain | Decay |
|---|---|---|
| `correction` | A research dead end or misread authority: "this citation was overruled in 2019", "clause 4 argument rejected by this bench before" | Never decays; repeating a corrected error in court is the worst failure mode |
| `milestone` | A matter decision: theory of the case chosen, settlement posture set, key ruling received | Never decays for the life of the matter |
| `preference` | How this lawyer works: citation format, argument structure, risk appetite in drafting | Never decays; personal subject, not matter subject |
| `episodic` | Research session traces: queries run, passages considered and rejected | 30-day half-life; rejected paths still matter short-term to avoid re-treading |
| `semantic` | Matter facts: parties, dates, forum, procedural posture | Never decays; the chronology backbone |

## Retrieval policy

Recall is scoped to the matter subject. Corrections and semantic facts dominate ranking; episodic research traces surface only when the current query resembles a recent one (avoiding duplicated research is a measurable win).

## Retention and disposal

- Matter memory follows the firm's retention schedule; `compact` handles episodic decay, but end-of-retention disposal is a bulk `forget` driven by the deployment, not the platform
- Conflicts screening: memory is partitioned per matter; cross-matter recall is architecturally impossible because recall is keyed by `subjectId`
- Export: full memory plus reasoning traces must serialize to a portable format for file transfer to successor counsel
