"""Python CRDT merge_states throughput — parity with JS crdt_merge.bench.mjs.

Measures ``sutra_orchestrator.crdt_merge.merge_states`` over growing documents.
"""

from __future__ import annotations

from sutra_orchestrator import PROTOCOL_VERSION
from sutra_orchestrator.contract_models import (
    CognitiveState,
    ConceptMastery,
    FrictionSample,
    SubjectProfile,
)
from sutra_orchestrator.crdt_merge import merge_states

from .harness import BENCH_DEVICE_ID, BENCH_SUBJECT_ID, bench


def _hlc(ms: int, logical: int, device: str) -> str:
    return f"{ms:015d}:{logical:06d}:{device}"


def make_state(device: str, concepts: int, samples: int) -> CognitiveState:
    mastery = {
        f"concept.{i}": ConceptMastery(
            conceptId=f"concept.{i}",
            alpha={device: float(i % 7)},
            beta={device: float(i % 3)},
            lastExercisedAt=_hlc(1_000_000 + i, 0, device),
        )
        for i in range(concepts)
    }
    outcomes = ("correct", "partial", "incorrect", "ungraded")
    friction_log = [
        FrictionSample(
            conceptId=f"concept.{i % concepts}",
            hesitationMs=1000 + i,
            inputVelocity=3.1,
            revisionCount=i % 4,
            assistanceRequested=(i % 5 == 0),
            outcome=outcomes[i % 4],  # type: ignore[arg-type]
            capturedAt=_hlc(2_000_000 + i, i % 100, device),
        )
        for i in range(samples)
    ]
    return CognitiveState(
        protocolVersion=PROTOCOL_VERSION,  # type: ignore[arg-type]
        subjectId=BENCH_SUBJECT_ID,
        deviceIds=[device],
        activeConceptId="concept.0",
        mode="exploratory",
        mastery=mastery,
        frictionLog=friction_log,
        profile=SubjectProfile(
            ageBand="adult",
            track="bench-track",
            language="en-IN",
            updatedAt=_hlc(3_000_000, 0, device),
        ),
        stateVector={"session": _hlc(3_000_000, 1, device)},
    )


def run() -> None:
    for concepts, samples in ((10, 20), (50, 200), (200, 1000)):
        a = make_state("device-aaaa", concepts, samples)
        b = make_state("device-bbbb", concepts, samples)

        def _once(left: CognitiveState = a, right: CognitiveState = b) -> None:
            merged, _advisories = merge_states(left, right)
            if merged.subjectId != BENCH_SUBJECT_ID:
                raise RuntimeError("merge subject isolation violated")

        bench(
            f"py merge {concepts} concepts / {samples} samples",
            _once,
            warmup=10,
            iterations=80 if concepts < 200 else 40,
            subject_id=BENCH_SUBJECT_ID,
            device_id=BENCH_DEVICE_ID,
        )


if __name__ == "__main__":
    run()
