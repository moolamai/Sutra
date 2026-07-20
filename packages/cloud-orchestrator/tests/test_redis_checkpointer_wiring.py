"""Redis checkpointer wired into LangGraph."""

from __future__ import annotations

import logging
import os
import uuid

import pytest

from sutra_orchestrator.checkpointer import (
    ADVISORY_CORRUPT_RESET,
    checkpoint_redis_key,
    checkpoint_thread_id,
    select_langgraph_checkpointer,
)
from sutra_orchestrator.contract_models import ConceptMastery, FrictionSample
from sutra_orchestrator.task_router import TaskRouter, demo_task_graph


def _friction(*, spike: bool = False) -> FrictionSample:
    return FrictionSample(
        conceptId="math.ratios",
        hesitationMs=20_000 if spike else 500,
        inputVelocity=2.0,
        revisionCount=0,
        assistanceRequested=spike,
        outcome="incorrect" if spike else "correct",
        capturedAt="000000001000000:000000:edge-aaaa",
    )


def _mastery(alpha: float = 3.0) -> dict[str, ConceptMastery]:
    return {
        "math.ratios": ConceptMastery(
            conceptId="math.ratios",
            alpha={"edge-aaaa": alpha},
            beta={"edge-aaaa": 1.0},
            lastExercisedAt="000000001000000:000000:edge-aaaa",
        ),
        "math.fractions": ConceptMastery(
            conceptId="math.fractions",
            alpha={"edge-aaaa": 0.2},
            beta={"edge-aaaa": 1.0},
            lastExercisedAt="000000001000000:000000:edge-aaaa",
        ),
    }


def test_happy_path_unset_redis_uses_memory_checkpointer() -> None:
    router = TaskRouter(demo_task_graph(), redis_url=None)
    assert router.checkpoint_backend == "memory"
    out = router.route_turn(
        subject_id=f"rtr-{uuid.uuid4().hex[:8]}",
        active_concept_id="math.ratios",
        mode="exploratory",
        friction=_friction(spike=False),
        mastery=_mastery(alpha=10.0),
    )
    assert out["guidance_directive"].startswith("GUIDE")
    assert "utterance" not in out["guidance_directive"]


def test_edge_redis_unavailable_degrades_to_memory(
    caplog: pytest.LogCaptureFixture,
) -> None:
    bad = "redis://127.0.0.1:1/0"
    with caplog.at_level(logging.WARNING, logger="sutra_orchestrator.checkpointer"):
        saver = select_langgraph_checkpointer(bad)
    assert getattr(saver, "backend_name", None) == "memory"
    joined = " ".join(r.getMessage() for r in caplog.records)
    assert "outcome=degraded" in joined
    assert "redis_unavailable" in joined


def test_edge_subject_thread_ids_do_not_collide() -> None:
    a = f"subj-a-{uuid.uuid4().hex[:6]}"
    b = f"subj-b-{uuid.uuid4().hex[:6]}"
    ta = checkpoint_thread_id(a)
    tb = checkpoint_thread_id(b)
    assert ta != tb
    assert checkpoint_redis_key(a, ta) != checkpoint_redis_key(b, tb)


def test_happy_path_route_turn_emits_structured_checkpoint_log(
    caplog: pytest.LogCaptureFixture,
) -> None:
    router = TaskRouter(demo_task_graph())
    subject = f"rtr-{uuid.uuid4().hex[:8]}"
    with caplog.at_level(logging.INFO, logger="sutra_orchestrator.task_router"):
        router.route_turn(
            subject_id=subject,
            active_concept_id="math.ratios",
            mode="exploratory",
            friction=_friction(spike=True),
            mastery=_mastery(alpha=1.0),
        )
    msgs = " ".join(r.getMessage() for r in caplog.records)
    assert f"subject_id={subject}" in msgs
    assert "checkpoint_backend=memory" in msgs
    assert "frictionLog" not in msgs


@pytest.mark.skipif(not os.environ.get("SUTRA_REDIS_URL"), reason="SUTRA_REDIS_URL not set")
def test_redis_checkpointer_survives_new_router_and_corrupt_reset(
    caplog: pytest.LogCaptureFixture,
) -> None:
    import redis as redis_lib

    url = os.environ["SUTRA_REDIS_URL"]
    client = redis_lib.Redis.from_url(url, decode_responses=False)
    try:
        client.ping()
    except Exception as err:
        pytest.skip(f"Redis not reachable: {err}")

    subject = f"rtr-redis-{uuid.uuid4().hex[:8]}"
    thread = checkpoint_thread_id(subject)
    key = checkpoint_redis_key(subject, thread)

    router_a = TaskRouter(demo_task_graph(), redis_url=url)
    assert router_a.checkpoint_backend == "redis"
    router_a.route_turn(
        subject_id=subject,
        active_concept_id="math.ratios",
        mode="exploratory",
        friction=_friction(spike=True),
        mastery=_mastery(alpha=1.0),
        session_id=None,
    )
    assert client.exists(key) == 1

    # New process-equivalent router hydrates from Redis (no crash).
    router_b = TaskRouter(demo_task_graph(), redis_url=url)
    out = router_b.route_turn(
        subject_id=subject,
        active_concept_id="math.ratios",
        mode="exploratory",
        friction=_friction(spike=False),
        mastery=_mastery(alpha=10.0),
    )
    assert out["subject_id"] == subject

    # Corrupt blob → clean start advisory (never crash-loop).
    client.set(key, b"not-a-pickle")
    with caplog.at_level(logging.WARNING, logger="sutra_orchestrator.checkpointer"):
        router_c = TaskRouter(demo_task_graph(), redis_url=url)
        router_c.route_turn(
            subject_id=subject,
            active_concept_id="math.ratios",
            mode="exploratory",
            friction=_friction(),
            mastery=_mastery(),
        )
    joined = " ".join(r.getMessage() for r in caplog.records)
    assert ADVISORY_CORRUPT_RESET in joined or "corrupt_reset" in joined
