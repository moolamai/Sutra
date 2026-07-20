"""Router resume semantics.

Mid-turn kill and resume without duplicate side effects.
Redis unreachable / corrupt / flushed checkpoints degrade
gracefully (memory mode or clean start + advisory) without crash loops.
"""

from __future__ import annotations

import logging
import operator
import os
import pickle
import uuid
from typing import Annotated, Any, TypedDict

import pytest
from langgraph.graph import END, StateGraph

from sutra_orchestrator.checkpointer import (
    ADVISORY_CORRUPT_RESET,
    ADVISORY_MISSING,
    RedisHydratingCheckpointer,
    checkpoint_redis_key,
    checkpoint_thread_id,
    select_langgraph_checkpointer,
)
from sutra_orchestrator.task_router import TaskRouter, demo_task_graph

logger = logging.getLogger(__name__)


class ResumeProbeState(TypedDict):
    subject_id: str
    step: int
    # Side-effect ledger: append-only via operator.add; resume must not redo.
    effects: Annotated[list[str], operator.add]
    guidance_directive: str
    remediation_depth: int


def _build_probe_graph(
    checkpointer: Any,
    *,
    interrupt_after: list[str] | None = None,
):
    """Mirror router stages with countable side effects (test surface only)."""

    def assess_friction(state: ResumeProbeState) -> dict[str, Any]:
        return {
            "step": state["step"] + 1,
            "effects": ["assess_friction"],
            "remediation_depth": state.get("remediation_depth", 0),
        }

    def remediate_prereq(state: ResumeProbeState) -> dict[str, Any]:
        depth = int(state.get("remediation_depth", 0)) + 1
        return {
            "step": state["step"] + 1,
            "effects": ["remediate_prereq"],
            "remediation_depth": depth,
        }

    def generate_guidance(state: ResumeProbeState) -> dict[str, Any]:
        depth = int(state.get("remediation_depth", 0))
        directive = (
            f"GUIDE concept='probe' mode=prerequisite-remediation "
            f"remediation_depth={depth}"
        )
        return {
            "step": state["step"] + 1,
            "effects": ["generate_guidance"],
            "guidance_directive": directive,
        }

    g: StateGraph = StateGraph(ResumeProbeState)
    g.add_node("assess_friction", assess_friction)
    g.add_node("remediate_prereq", remediate_prereq)
    g.add_node("generate_guidance", generate_guidance)
    g.set_entry_point("assess_friction")
    g.add_edge("assess_friction", "remediate_prereq")
    g.add_edge("remediate_prereq", "generate_guidance")
    g.add_edge("generate_guidance", END)
    return g.compile(
        checkpointer=checkpointer,
        interrupt_after=interrupt_after or [],
    )


def _run_config(subject_id: str) -> dict[str, Any]:
    thread_id = checkpoint_thread_id(subject_id)
    return {
        "configurable": {
            "thread_id": thread_id,
            "checkpoint_ns": "",
            "sutra_subject_id": subject_id,
        }
    }


def _initial(subject_id: str) -> ResumeProbeState:
    return {
        "subject_id": subject_id,
        "step": 0,
        "effects": [],
        "guidance_directive": "",
        "remediation_depth": 0,
    }


def _snapshot_memory_saver(saver: Any) -> bytes:
    """Serialize a MemorySaver for process-kill simulation without Redis."""
    return pickle.dumps(
        {
            "storage": {tid: dict(ns) for tid, ns in saver.storage.items()},
            "blobs": dict(saver.blobs),
            "writes": {k: dict(v) for k, v in saver.writes.items()},
        }
    )


def _restore_memory_saver(snap: bytes) -> Any:
    from langgraph.checkpoint.memory import MemorySaver

    data = pickle.loads(snap)
    saver = MemorySaver()
    for tid, ns in (data.get("storage") or {}).items():
        saver.storage[tid] = ns
    for bk, bv in (data.get("blobs") or {}).items():
        saver.blobs[bk] = bv
    for wk, wv in (data.get("writes") or {}).items():
        saver.writes[wk] = wv
    saver.backend_name = "memory"  # type: ignore[attr-defined]
    return saver


def _redis_reachable() -> str | None:
    url = os.environ.get("SUTRA_REDIS_URL")
    if not url:
        return None
    try:
        import redis as redis_lib

        client = redis_lib.Redis.from_url(url, socket_connect_timeout=1.5)
        client.ping()
        return url
    except Exception:
        return None


def test_happy_path_mid_turn_kill_resume_no_duplicate_effects(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Interrupt after remediate → 'kill' → resume → each effect once; directive stable."""
    subject = f"resume-{uuid.uuid4().hex[:8]}"
    config = _run_config(subject)

    # Reference: uninterrupted final directive.
    ref_saver = select_langgraph_checkpointer(None)
    ref_graph = _build_probe_graph(ref_saver, interrupt_after=[])
    reference = ref_graph.invoke(_initial(subject), _run_config(f"ref-{subject}"))
    expected_directive = reference["guidance_directive"]
    assert expected_directive.startswith("GUIDE")

    saver = select_langgraph_checkpointer(None)
    graph = _build_probe_graph(saver, interrupt_after=["remediate_prereq"])

    with caplog.at_level(logging.INFO):
        logger.info(
            "resume_probe subject_id=%s outcome=mid_turn_interrupt",
            subject,
        )
        mid = graph.invoke(_initial(subject), config)

    assert mid["effects"] == ["assess_friction", "remediate_prereq"]
    assert mid["guidance_directive"] == ""
    assert mid["remediation_depth"] == 1

    # Process kill: discard graph + saver process state; restore from snapshot.
    snap = _snapshot_memory_saver(saver)
    del graph
    del saver
    saver2 = _restore_memory_saver(snap)
    graph2 = _build_probe_graph(saver2, interrupt_after=["remediate_prereq"])

    final = graph2.invoke(None, config)
    assert final["effects"] == [
        "assess_friction",
        "remediate_prereq",
        "generate_guidance",
    ]
    assert final["guidance_directive"] == expected_directive
    assert final["remediation_depth"] == 1
    assert final["subject_id"] == subject

    # Idempotent second resume: already finished — no new effects.
    again = graph2.invoke(None, config)
    assert again["effects"] == final["effects"]
    assert again["guidance_directive"] == expected_directive

    joined = " ".join(r.getMessage() for r in caplog.records)
    assert f"subject_id={subject}" in joined
    assert "utterance" not in joined
    assert "frictionLog" not in joined


def test_edge_concurrent_subjects_do_not_cross_resume() -> None:
    saver = select_langgraph_checkpointer(None)
    graph = _build_probe_graph(saver, interrupt_after=["assess_friction"])

    a = f"resume-a-{uuid.uuid4().hex[:6]}"
    b = f"resume-b-{uuid.uuid4().hex[:6]}"
    cfg_a = _run_config(a)
    cfg_b = _run_config(b)

    mid_a = graph.invoke(_initial(a), cfg_a)
    mid_b = graph.invoke(_initial(b), cfg_b)
    assert mid_a["effects"] == ["assess_friction"]
    assert mid_b["effects"] == ["assess_friction"]
    assert mid_a["subject_id"] == a
    assert mid_b["subject_id"] == b

    # Finish A only; B must remain interrupted.
    fin_a = graph.invoke(None, cfg_a)
    assert "generate_guidance" in fin_a["effects"]
    assert fin_a["subject_id"] == a

    still_b = graph.get_state(cfg_b)
    assert still_b.values["subject_id"] == b
    assert still_b.values["effects"] == ["assess_friction"]
    assert still_b.next  # still has pending nodes


def test_edge_replay_after_complete_is_idempotent() -> None:
    subject = f"resume-idemp-{uuid.uuid4().hex[:8]}"
    config = _run_config(subject)
    saver = select_langgraph_checkpointer(None)
    graph = _build_probe_graph(saver, interrupt_after=["assess_friction"])
    graph.invoke(_initial(subject), config)
    first = graph.invoke(None, config)
    second = graph.invoke(None, config)
    assert first["guidance_directive"] == second["guidance_directive"]
    assert first["effects"] == second["effects"]
    assert first["effects"].count("generate_guidance") == 1


@pytest.mark.skipif(_redis_reachable() is None, reason="SUTRA_REDIS_URL Redis not reachable")
def test_redis_process_kill_resume_no_duplicate_effects() -> None:
    """Operator path: Redis-backed checkpointer survives true process-equivalent restart."""
    url = _redis_reachable()
    assert url is not None
    subject = f"resume-redis-{uuid.uuid4().hex[:8]}"
    config = _run_config(subject)
    thread_id = checkpoint_thread_id(subject)
    key = checkpoint_redis_key(subject, thread_id)

    import redis as redis_lib

    client = redis_lib.Redis.from_url(url, decode_responses=False)
    client.delete(key)

    # Reference directive from uninterrupted memory run.
    ref = _build_probe_graph(select_langgraph_checkpointer(None), interrupt_after=[])
    expected = ref.invoke(_initial(subject), _run_config(f"ref-{subject}"))[
        "guidance_directive"
    ]

    saver_a = select_langgraph_checkpointer(url)
    assert getattr(saver_a, "backend_name", None) == "redis"
    assert isinstance(saver_a, RedisHydratingCheckpointer)
    graph_a = _build_probe_graph(saver_a, interrupt_after=["remediate_prereq"])
    mid = graph_a.invoke(_initial(subject), config)
    assert mid["effects"] == ["assess_friction", "remediate_prereq"]
    assert client.exists(key) == 1

    # Kill process: drop graph/saver; fresh Redis hydrator loads from Redis only.
    del graph_a
    del saver_a
    saver_b = select_langgraph_checkpointer(url)
    graph_b = _build_probe_graph(saver_b, interrupt_after=["remediate_prereq"])
    final = graph_b.invoke(None, config)

    assert final["effects"] == [
        "assess_friction",
        "remediate_prereq",
        "generate_guidance",
    ]
    assert final["effects"].count("assess_friction") == 1
    assert final["effects"].count("remediate_prereq") == 1
    assert final["effects"].count("generate_guidance") == 1
    assert final["guidance_directive"] == expected
    assert final["subject_id"] == subject


# ── : degradation (Redis down / corrupt / flush) ────────────────


class _FakeRedis:
    """Minimal Redis stand-in for corrupt/flush degradation without a daemon."""

    def __init__(self) -> None:
        self.data: dict[bytes | str, bytes] = {}
        self.deleted: list[bytes | str] = []

    def get(self, key: bytes | str) -> bytes | None:
        return self.data.get(key)

    def set(self, key: bytes | str, value: bytes) -> bool:
        self.data[key] = value
        return True

    def delete(self, *keys: bytes | str) -> int:
        n = 0
        for key in keys:
            self.deleted.append(key)
            if key in self.data:
                del self.data[key]
                n += 1
        return n

    def ping(self) -> bool:
        return True

    def exists(self, key: bytes | str) -> int:
        return 1 if key in self.data else 0


def test_happy_path_redis_unreachable_degrades_to_memory_no_crash(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Redis unreachable → checkpoint-less (memory) with warning; router still runs."""
    bad = "redis://127.0.0.1:1/0"
    with caplog.at_level(logging.WARNING, logger="sutra_orchestrator.checkpointer"):
        saver = select_langgraph_checkpointer(bad)
        router = TaskRouter(demo_task_graph(), redis_url=bad)

    assert getattr(saver, "backend_name", None) == "memory"
    assert router.checkpoint_backend == "memory"

    subject = f"degrade-{uuid.uuid4().hex[:8]}"
    graph = _build_probe_graph(saver, interrupt_after=[])
    out = graph.invoke(_initial(subject), _run_config(subject))
    assert out["guidance_directive"].startswith("GUIDE")
    assert out["effects"].count("generate_guidance") == 1

    joined = " ".join(r.getMessage() for r in caplog.records)
    assert "outcome=degraded" in joined
    assert "redis_unavailable" in joined
    assert "utterance" not in joined


def test_edge_corrupt_checkpoint_starts_clean_with_advisory(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Corrupt Redis blob → delete key, clean start + advisory, no crash loop."""
    subject = f"degrade-corrupt-{uuid.uuid4().hex[:8]}"
    config = _run_config(subject)
    thread_id = checkpoint_thread_id(subject)
    key = checkpoint_redis_key(subject, thread_id)

    fake = _FakeRedis()
    fake.set(key, b"not-a-valid-pickle{{{")
    saver = RedisHydratingCheckpointer(fake)
    graph = _build_probe_graph(saver, interrupt_after=[])

    with caplog.at_level(logging.WARNING, logger="sutra_orchestrator.checkpointer"):
        out = graph.invoke(_initial(subject), config)

    assert out["subject_id"] == subject
    assert out["guidance_directive"].startswith("GUIDE")
    assert out["effects"] == [
        "assess_friction",
        "remediate_prereq",
        "generate_guidance",
    ]
    # Corrupt key removed so the next hydrate cannot crash-loop.
    assert key in fake.deleted or fake.get(key) is None or fake.get(key) != b"not-a-valid-pickle{{{"

    joined = " ".join(r.getMessage() for r in caplog.records)
    assert "corrupt_reset" in joined
    assert ADVISORY_CORRUPT_RESET in joined
    assert f"subject_id={subject}" in joined
    assert "frictionLog" not in joined


def test_edge_redis_flush_mid_operation_starts_fresh_thread(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Flush checkpoint mid-turn → next invoke starts clean (miss advisory), not crash."""
    subject = f"degrade-flush-{uuid.uuid4().hex[:8]}"
    config = _run_config(subject)
    thread_id = checkpoint_thread_id(subject)
    key = checkpoint_redis_key(subject, thread_id)

    fake = _FakeRedis()
    saver = RedisHydratingCheckpointer(fake)
    graph = _build_probe_graph(saver, interrupt_after=["remediate_prereq"])

    mid = graph.invoke(_initial(subject), config)
    assert mid["effects"] == ["assess_friction", "remediate_prereq"]
    assert fake.exists(key) == 1

    # Operator flush / Redis FLUSHDB equivalent for this subject key.
    fake.delete(key)
    assert fake.exists(key) == 0

    # Process-equivalent restart: new hydrator sees miss → fresh thread.
    saver2 = RedisHydratingCheckpointer(fake)
    graph2 = _build_probe_graph(saver2, interrupt_after=[])

    with caplog.at_level(logging.INFO, logger="sutra_orchestrator.checkpointer"):
        fresh = graph2.invoke(_initial(subject), config)

    # Fresh start — full effects again (not a partial resume from flushed mid-state).
    assert fresh["effects"] == [
        "assess_friction",
        "remediate_prereq",
        "generate_guidance",
    ]
    assert fresh["guidance_directive"].startswith("GUIDE")
    assert fresh["subject_id"] == subject

    joined = " ".join(r.getMessage() for r in caplog.records)
    assert "outcome=miss" in joined or ADVISORY_MISSING in joined


def test_edge_degraded_mode_isolates_subjects() -> None:
    """Even in memory degrade mode, two subjects keep separate threads."""
    saver = select_langgraph_checkpointer("redis://127.0.0.1:1/0")
    assert getattr(saver, "backend_name", None) == "memory"
    graph = _build_probe_graph(saver, interrupt_after=["assess_friction"])

    a = f"deg-a-{uuid.uuid4().hex[:6]}"
    b = f"deg-b-{uuid.uuid4().hex[:6]}"
    graph.invoke(_initial(a), _run_config(a))
    graph.invoke(_initial(b), _run_config(b))
    fin_a = graph.invoke(None, _run_config(a))
    assert fin_a["subject_id"] == a
    assert "generate_guidance" in fin_a["effects"]
    assert graph.get_state(_run_config(b)).values["subject_id"] == b
    assert graph.get_state(_run_config(b)).values["effects"] == ["assess_friction"]
