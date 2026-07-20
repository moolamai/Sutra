"""Python bench parity — harness + sync_merge + agent_runtime."""

from __future__ import annotations

import json
import re
import sys
import threading
from pathlib import Path

import pytest

pytestmark = pytest.mark.slow

_PKG_ROOT = Path(__file__).resolve().parents[1]
if str(_PKG_ROOT) not in sys.path:
    sys.path.insert(0, str(_PKG_ROOT))

from benchmarks.agent_runtime_bench import build_runtime, run as run_agent_runtime
from benchmarks.harness import (
    BENCH_SUBJECT_ID,
    begin_capture,
    bench,
    emit_sample_telemetry,
    end_capture,
    format_bench_line,
    max_p95,
    percentile,
    run_capture,
)
from benchmarks.sync_merge_bench import make_state, run as run_sync_merge
from sutra_orchestrator import PROTOCOL_VERSION
from sutra_orchestrator.contract_models import AgentTurnRequest, FrictionSample
from sutra_orchestrator.crdt_merge import IrreconcilableStateError, merge_states
from sutra_orchestrator.model_provider import DeterministicFakeProvider

BENCH_DIR = _PKG_ROOT / "benchmarks"
LINE_RE = re.compile(
    r"^.+?\s+p50=\d+\.\d{3}ms\s+p95=\d+\.\d{3}ms\s+p99=\d+\.\d{3}ms\s+"
    r"mean=\d+\.\d{3}ms\s+ops/s=\d+$"
)


def _hlc() -> str:
    return f"{1_700_000_000_100:015d}:000000:edge-bench"


def test_happy_path_harness_line_matches_bench_mjs_shape(capsys: pytest.CaptureFixture[str]) -> None:
    result = bench("py harness self-check", lambda: None, warmup=2, iterations=10)
    assert result["p95"] >= 0
    assert result["subjectId"] == BENCH_SUBJECT_ID
    out = capsys.readouterr().out
    human = [ln for ln in out.splitlines() if "p50=" in ln][0]
    assert LINE_RE.match(human), human
    samples = [json.loads(ln) for ln in out.splitlines() if ln.startswith("{")]
    assert any(s.get("event") == "benchmarks.sample" for s in samples)
    for s in samples:
        assert "utterance" not in s
        assert "prompt" not in s


def test_happy_path_sync_merge_and_agent_runtime_capture() -> None:
    doc = run_capture(lambda: (run_sync_merge(), run_agent_runtime()))
    assert doc["schemaVersion"] == "bench-capture.v1"
    assert doc["unit"] == "ms"
    assert doc["metric"] == "p95"
    assert isinstance(doc["measuredP95"], float)
    assert doc["measuredP95"] > 0
    names = {s["name"] for s in doc["samples"]}
    assert any("py merge" in n for n in names)
    assert any("agent_runtime" in n for n in names)


def test_edge_cross_subject_merge_refuses() -> None:
    a = make_state("device-aaaa", 5, 5)
    b = make_state("device-bbbb", 5, 5)
    foreign = b.model_copy(update={"subjectId": "other-subject"})
    with pytest.raises(IrreconcilableStateError):
        merge_states(a, foreign)


def test_edge_zero_sleep_fake_provider_and_no_sleep_in_bench_sources() -> None:
    src_agent = (BENCH_DIR / "agent_runtime_bench.py").read_text(encoding="utf-8")
    src_merge = (BENCH_DIR / "sync_merge_bench.py").read_text(encoding="utf-8")
    assert "DeterministicFakeProvider" in src_agent
    # Hard forbid wall-clock sleeps in bench modules (NFR composition path).
    assert "time.sleep" not in src_agent
    assert "time.sleep" not in src_merge
    assert "asyncio.sleep" not in src_agent

    rt = build_runtime("subj-bench-zs")
    assert isinstance(rt.model_provider, DeterministicFakeProvider)
    resp = rt.run_turn(
        AgentTurnRequest(
            protocolVersion=PROTOCOL_VERSION,  # type: ignore[arg-type]
            subjectId="subj-bench-zs",
            sessionId="s1",
            utterance="benchmark utterance",
            friction=FrictionSample(
                conceptId="math.ratios",
                hesitationMs=100,
                inputVelocity=1.0,
                revisionCount=0,
                assistanceRequested=False,
                outcome="correct",
                capturedAt=_hlc(),
            ),
        )
    )
    assert resp.reply
    assert "[directive]" not in resp.reply


def test_edge_idempotent_merge_replay_and_seeded_slowdown_headroom() -> None:
    a = make_state("device-aaaa", 10, 20)
    b = make_state("device-bbbb", 10, 20)
    first, _ = merge_states(a, b)
    second, _ = merge_states(first, b)
    assert first.subjectId == second.subjectId == BENCH_SUBJECT_ID
    # Idempotent: re-merge of (acc,b) stays on same subject / mode family.
    assert second.mode == first.mode

    # Seeded slowdown signal for gate consumers (printable measured vs budget).
    measured = 99.0
    budget = 50.0
    headroom = (budget - measured) / budget * 100.0
    assert headroom < 0
    line = format_bench_line(
        "seeded-slowdown", p50=measured, p95=measured, p99=measured, mean=measured
    )
    assert "99.000ms" in line


def test_sovereignty_telemetry_omits_learner_bodies(
    capsys: pytest.CaptureFixture[str],
) -> None:
    emit_sample_telemetry(
        {
            "name": "leak-check",
            "subjectId": "subj-a",
            "deviceId": "d",
            "p50": 1.0,
            "p95": 2.0,
            "p99": 3.0,
            "mean": 1.5,
            "utterance": "secret learner essay",
            "prompt": "should not appear",
            "reply": "secret reply",
        }
    )
    out = capsys.readouterr().out.strip()
    payload = json.loads(out)
    assert payload["event"] == "benchmarks.sample"
    assert payload["subjectId"] == "subj-a"
    assert "utterance" not in payload
    assert "prompt" not in payload
    assert "reply" not in payload
    assert "secret" not in out


def test_edge_concurrent_same_subject_turns_serialized() -> None:
    rt = build_runtime("subj-conc")
    errors: list[BaseException] = []
    results: list[str] = []

    def worker(i: int) -> None:
        try:
            resp = rt.run_turn(
                AgentTurnRequest(
                    protocolVersion=PROTOCOL_VERSION,  # type: ignore[arg-type]
                    subjectId="subj-conc",
                    sessionId=f"c-{i}",
                    utterance="benchmark utterance",
                    friction=FrictionSample(
                        conceptId="math.ratios",
                        hesitationMs=100,
                        inputVelocity=1.0,
                        revisionCount=0,
                        assistanceRequested=False,
                        outcome="correct",
                        capturedAt=_hlc(),
                    ),
                )
            )
            results.append(resp.reply)
        except BaseException as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)
    assert not errors, errors
    assert len(results) == 4


def test_percentile_and_capture_helpers() -> None:
    assert percentile([1.0, 2.0, 3.0, 4.0], 95) == 4.0
    begin_capture()
    bench("capture-a", lambda: None, warmup=1, iterations=5, emit_structured=False)
    samples = end_capture()
    assert len(samples) == 1
    assert max_p95(samples) == samples[0]["p95"]
