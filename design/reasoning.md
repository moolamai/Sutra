# Design: reasoning

## The stance

A reasoning engine owes its caller an honest account. The trace is not an explanation generated after the fact to look plausible; it is the record of what the engine actually did. If the engine ran one model call and formatted the output, the trace says so. Fabricated deliberation is worse than no trace because it launders confidence.

## Constraints as a first-class channel

Callers push invariants in; the engine verifies what it can and returns the rest in `unresolvedConstraints`. The design rule: the engine may never silently drop a constraint. This single rule is what makes the contract usable in clinical and legal domains, and it costs nothing in casual domains. Downstream policy (block the reply, flag it, escalate) is the caller's business.

## Confidence

Confidence is only useful if it is calibrated, and calibration requires outcomes. The reference expectation is modest: engines should expose raw signals (self-consistency across samples, verifier agreement) and let deployments calibrate against their own outcome data. A hardcoded 0.95 is a lie; when an engine cannot estimate, it should say 0.5 and let the trace speak.

## Step kinds

The five step kinds (`inference`, `verification`, `counterargument`, `assumption`, `retrieval`) were chosen because each one changes what a reviewer does with the trace: verifications get spot-checked, assumptions get challenged, counterarguments get weighed. A step kind that would not change reviewer behavior does not deserve to exist. Resist adding kinds.

## Composition

Reasoning engines compose behind the single contract: a verifier loop is one engine wrapping another; a symbolic checker is an engine that delegates prose to an LLM and math to a solver. The contract stays ignorant of the composition; the trace reveals it. This is the intended growth path, rather than widening the interface with engine-specific options.
