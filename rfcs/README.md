# RFCs

Substantial changes to Sutra happen through Requests for Comments. If a change alters a public contract, the wire protocol, the memory kind vocabulary, the dependency rules, or the repository philosophy, it needs an RFC before code. Bug fixes, documentation, new domains, new examples, and internal refactors do not.

## The process

1. Copy [`0000-template.md`](0000-template.md) to `rfcs/0000-my-proposal.md` on a branch.
2. Fill it in. The hard sections (drawbacks, alternatives, unresolved questions) are the point; an RFC without honest drawbacks is not done.
3. Open a PR. Discussion happens on the PR; revise the text as consensus forms.
4. A maintainer calls the decision per the governance process. Accepted RFCs are assigned the next number and merged; rejected RFCs are closed with the reasoning summarized in the PR.
5. Implementation lands in follow-up PRs referencing the RFC. When the architecture consequence is durable, an ADR records it in `docs/adr/`.

## Status of this directory

Only accepted RFCs live here. The numbering starts when the first proposal is accepted; an empty directory means the contracts have not needed to change yet, which is the healthy state.

## What makes a good RFC

- It changes the smallest surface that solves the problem
- It shows the change working across at least two domains (a contract change that helps only one profession is probably domain logic in disguise)
- It answers "what does this do offline" and "what does this do to sync"
- It respects the things-not-to-add list in the repository philosophy
