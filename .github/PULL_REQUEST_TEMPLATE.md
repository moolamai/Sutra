

## What does this PR do?



## Linked issue



Closes #

## Type of change



- [ ] Bug fix (restores documented behavior, includes a test that fails without the fix)
- [ ] Feature (no wire contract or cognitive contract changes)
- [ ] RFC implementation (link the accepted RFC issue below)
- [ ] Documentation
- [ ] Tests / CI / tooling only
- [ ] Domain configuration (task graph, connector, tool pack, profile, domain specification)

Accepted RFC (if applicable): #

## Contract and parity checklist



- [ ] This PR does **not** change `sync-protocol/src/contract.ts` or any `contracts/src/`* interface, **or** it implements an accepted RFC
- [ ] Wire format changes (if any) are additive-only
- [ ] CRDT changes (if any) are mirrored in **both** TypeScript and Python, and both smoke/property tests pass
- [ ] Pydantic models still mirror the TS contract field-for-field (if either was touched)



## How was this tested?



```
pnpm build && pnpm typecheck
node packages/sync-protocol/smoke_test.mjs
python packages/cloud-orchestrator/smoke_test.py
```

- [ ] Full local gate above passes
- [ ] New/changed behavior is covered by tests (see CONTRIBUTING.md section 7)
- [ ] For user-visible changes: screenshot or capture attached



## Documentation

- [ ] Docs updated where behavior changed (`docs/`, package READMEs, JSDoc/docstrings), or N/A because:



## Anything reviewers should focus on?



---

- [x] My commits are signed off (`git commit -s`, DCO)
- [ ] I have read [CONTRIBUTING.md](../CONTRIBUTING.md) and this PR follows it