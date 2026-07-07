# Teacher: memory semantics

How the generic memory kinds map to education, and what must never be forgotten.

## Kind mapping

| Generic kind | In this domain | Decay |
|---|---|---|
| `correction` | A misconception: "confuses ratio with fraction notation", "thinks multiplication always increases" | Never decays. A dormant misconception resurfacing months later is exactly what long-term teaching must catch |
| `milestone` | A breakthrough: first correct multi-step proof, fluency threshold crossed on a track | Never decays; anchors motivation and pacing decisions |
| `preference` | Learning style signals: prefers visual explanations, responds well to sports analogies, evening study pattern | Never decays; refreshed by overwrite |
| `episodic` | Raw session traces: what was asked, what was answered, hesitation patterns | 30-day half-life; compacted after 180 days |
| `semantic` | Distilled facts about the learner's context: grade level, board, home language | Never decays; low volume |

## Retrieval policy

Recall before every turn is scoped to the active concept first, then widened. Corrections always rank above episodics of equal similarity because the decay multiplier only applies to episodics. This is the platform default; the domain adds nothing custom.

## Mastery vs memory

Mastery posteriors (the `mastery` map in `CognitiveState`) are NOT memories. They are CRDT counters folded from friction samples and live in the state document, not the vector store. Memory answers "what do we know about this learner"; mastery answers "how consolidated is each concept".

## Privacy constraints

- Raw keystrokes and free-text answers stay on device; only behavioral metadata (friction samples) syncs
- Memory text syncs to the deployment's own cloud (sovereign posture); no third-party processors
- A guardian-initiated forget request maps to `MemoryInterface.forget` plus mastery reset for the affected concepts
