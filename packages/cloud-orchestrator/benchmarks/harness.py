"""bench.mjs-compatible timing harness for Python cloud benches.

Human line (pad name to 38):
  ``name… p50=…ms  p95=…ms  p99=…ms  mean=…ms  ops/s=…``

Structured capture (never includes utterance / learner bodies)::
  ``{"event":"benchmarks.sample","subjectId":...,"deviceId":...,"name":...,"p50":...,"p95":...,"p99":...,"mean":...,"outcome":"ok"}``
"""

from __future__ import annotations

import json
import math
import statistics
import sys
import time
from collections.abc import Callable
from typing import Any

BENCH_SUBJECT_ID = "bench-subject"
BENCH_DEVICE_ID = "bench-harness-python"
BENCH_CAPTURE_LIMIT = 32

_capture_enabled = False
_capture_session: list[dict[str, Any]] = []


def begin_capture() -> None:
    global _capture_enabled, _capture_session
    _capture_enabled = True
    _capture_session = []


def end_capture() -> list[dict[str, Any]]:
    global _capture_enabled, _capture_session
    _capture_enabled = False
    samples = _capture_session
    _capture_session = []
    return samples


def get_capture() -> list[dict[str, Any]]:
    return list(_capture_session)


def percentile(sorted_samples: list[float], p: float) -> float:
    if not sorted_samples:
        return float("nan")
    idx = min(len(sorted_samples) - 1, math.floor((p / 100.0) * len(sorted_samples)))
    return sorted_samples[idx]


def max_p95(samples: list[dict[str, Any]]) -> float:
    if not samples:
        return float("nan")
    return max(float(s["p95"]) for s in samples)


def format_bench_line(
    name: str,
    *,
    p50: float,
    p95: float,
    p99: float,
    mean: float,
) -> str:
    ops = 0 if mean <= 0 else round(1000.0 / mean)
    return (
        f"{name:<38} "
        f"p50={p50:.3f}ms  p95={p95:.3f}ms  p99={p99:.3f}ms  "
        f"mean={mean:.3f}ms  ops/s={ops}"
    )


def emit_sample_telemetry(event: dict[str, Any]) -> None:
    payload = {
        "event": "benchmarks.sample",
        "subjectId": event.get("subjectId", BENCH_SUBJECT_ID),
        "deviceId": event.get("deviceId", BENCH_DEVICE_ID),
        "outcome": event.get("outcome", "ok"),
        **{k: v for k, v in event.items() if k not in ("subjectId", "deviceId", "outcome")},
    }
    # Never allow utterance / learner content keys in telemetry.
    for banned in ("utterance", "prompt", "reply", "text", "content"):
        payload.pop(banned, None)
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")


def bench(
    name: str,
    fn: Callable[[], Any],
    *,
    warmup: int = 20,
    iterations: int = 200,
    subject_id: str = BENCH_SUBJECT_ID,
    device_id: str = BENCH_DEVICE_ID,
    emit_structured: bool = True,
) -> dict[str, Any]:
    if not subject_id or not str(subject_id).strip():
        raise ValueError("bench: subject_id required (subject isolation)")

    for _ in range(warmup):
        fn()

    samples_ms: list[float] = []
    for _ in range(iterations):
        t0 = time.perf_counter()
        fn()
        samples_ms.append((time.perf_counter() - t0) * 1000.0)

    sorted_ms = sorted(samples_ms)
    p50 = percentile(sorted_ms, 50)
    p95 = percentile(sorted_ms, 95)
    p99 = percentile(sorted_ms, 99)
    mean = statistics.fmean(sorted_ms)

    line = format_bench_line(name, p50=p50, p95=p95, p99=p99, mean=mean)
    sys.stdout.write(line + "\n")

    result = {
        "name": name,
        "p50": p50,
        "p95": p95,
        "p99": p99,
        "mean": mean,
        "subjectId": subject_id,
        "deviceId": device_id,
        "iterations": iterations,
    }

    if _capture_enabled and len(_capture_session) < BENCH_CAPTURE_LIMIT:
        _capture_session.append(
            {
                "name": name,
                "p50": p50,
                "p95": p95,
                "p99": p99,
                "mean": mean,
                "subjectId": subject_id,
                "deviceId": device_id,
            }
        )

    if emit_structured:
        emit_sample_telemetry(
            {
                "name": name,
                "subjectId": subject_id,
                "deviceId": device_id,
                "p50": p50,
                "p95": p95,
                "p99": p99,
                "mean": mean,
                "iterations": iterations,
                "outcome": "ok",
            }
        )

    return result


def run_capture(runner: Callable[[], None]) -> dict[str, Any]:
    """Run a bench module body under capture; return max-p95 document slice."""
    begin_capture()
    try:
        runner()
        samples = end_capture()
    except Exception:
        end_capture()
        raise
    measured = max_p95(samples)
    return {
        "schemaVersion": "bench-capture.v1",
        "unit": "ms",
        "metric": "p95",
        "samples": samples,
        "measuredP95": measured,
    }
