# memory

The on-device vector store (`LocalVectorDb`) over a minimal in-memory `StorageDriver`. Shows the retrieval semantics the platform guarantees: cosine similarity weighted by kind-aware decay, where corrections never decay and episodic memories fade with a 30-day half-life.

```bash
pnpm memory
```
