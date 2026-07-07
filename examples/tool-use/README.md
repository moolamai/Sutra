# tool-use

The tool contract in action: a registry with risk classes (`read`, `compute`, `write`, `critical`), schema validation of arguments, deadline enforcement, and an execution policy that denies critical actions without approval. Errors are returned as values, never thrown, so a bad tool call cannot crash an agent.

```bash
pnpm tool-use
```
