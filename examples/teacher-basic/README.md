# teacher-basic

The cognitive core configured as an education mentor. Knowledge is loaded as
**data** from `knowledge-packs/teacher-cbse-slice/` via
`PackKnowledgeConnector` — packages never import `domains/teacher`.

Compare with `../lawyer-basic/main.mjs`: the `CognitiveCore`, the loop, and
every contract are identical; only the profile (charter, refusals) and the
knowledge pack path differ.

```bash
pnpm teacher-basic
```

Domain authoring guidance still lives under `domains/teacher/`; the runtime
consumes only the validated pack under `knowledge-packs/`.

