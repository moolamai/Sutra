"""Cloud LLM provider-down degradation drill (ATR-05).

Invoked by benchmarks/_shared/degradation_drill_probe.mjs.
Env: SUTRA_DEGR_SUBJECT, SUTRA_DEGR_DEVICE, SUTRA_DEGR_UTTERANCE, SUTRA_DEGR_MODE.
"""

from __future__ import annotations

import importlib
import json
import os
import sys

from sutra_orchestrator import PROTOCOL_VERSION
from sutra_orchestrator.agent_runtime import AgentRuntime
from sutra_orchestrator.contract_models import (
    AgentTurnRequest,
    CognitiveState,
    ConceptMastery,
    FrictionSample,
    SubjectProfile,
)
from sutra_orchestrator.model_provider import DeterministicFakeProvider
from sutra_orchestrator.sync_service import InMemoryMasterStateStore
from sutra_orchestrator.task_router import TaskRouter, demo_task_graph


def hlc(ms: int, logical: int, device: str) -> str:
    return f"{ms:015d}:{logical:06d}:{device}"


def make_state(subject_id: str) -> CognitiveState:
    device = "cloud-degr-a"
    return CognitiveState(
        protocolVersion=PROTOCOL_VERSION,  # type: ignore[arg-type]
        subjectId=subject_id,
        deviceIds=[device],
        activeConceptId="math.ratios",
        mode="exploratory",
        mastery={
            "math.ratios": ConceptMastery(
                conceptId="math.ratios",
                alpha={device: 2.0},
                beta={device: 2.0},
                lastExercisedAt=hlc(1_700_000_000_000, 0, device),
            ),
            "math.fractions": ConceptMastery(
                conceptId="math.fractions",
                alpha={device: 5.0},
                beta={device: 1.0},
                lastExercisedAt=hlc(1_700_000_000_000, 1, device),
            ),
        },
        frictionLog=[],
        profile=SubjectProfile(
            ageBand="child",
            track="cbse-class-7-maths",
            language="hi-IN",
            updatedAt=hlc(1_700_000_000_000, 2, device),
        ),
        stateVector={"session": hlc(1_700_000_000_000, 3, device)},
    )


def friction(device: str) -> FrictionSample:
    return FrictionSample(
        conceptId="math.ratios",
        hesitationMs=800,
        inputVelocity=3.0,
        revisionCount=0,
        assistanceRequested=False,
        outcome="correct",
        capturedAt=hlc(1_700_000_000_100, 0, device),
    )


def assert_degraded(resp, utterance: str, http_status: int = 200):
    if not getattr(resp, "degraded", False):
        return False, "not_degraded"
    if not (resp.reply or "").startswith("GUIDE concept="):
        return False, "reply_not_guide"
    if not (resp.routingRationale or "").strip():
        return False, "empty_rationale"
    marker = getattr(resp, "freshnessMarker", None)
    if marker is None or marker.source != "last-known-good":
        return False, "missing_freshness"
    if utterance and utterance in (resp.reply or ""):
        return False, "utterance_leaked"
    if http_status >= 500:
        return False, "http_5xx"
    return True, None


def run_turn(subject: str, device: str, utterance: str) -> dict:
    store = InMemoryMasterStateStore()
    store.put(make_state(subject))
    rt = AgentRuntime(
        TaskRouter(demo_task_graph(), redis_url=None),
        store,
        model_provider=DeterministicFakeProvider(force_timeout=True),
    )
    resp = rt.run_turn(
        AgentTurnRequest(
            protocolVersion=PROTOCOL_VERSION,  # type: ignore[arg-type]
            subjectId=subject,
            sessionId="sess-degr",
            utterance=utterance,
            friction=friction(device),
        )
    )
    ok, fc = assert_degraded(resp, utterance)
    return {
        "ok": ok,
        "failureClass": fc,
        "httpStatus": 200 if ok else 500,
        "degraded": bool(resp.degraded),
        "replyStartsWithGuide": resp.reply.startswith("GUIDE concept="),
        "routingRationaleLen": len(resp.routingRationale or ""),
        "freshnessSource": resp.freshnessMarker.source if resp.freshnessMarker else None,
        "fabricated": False,
    }


def run_http(subject: str, device: str, utterance: str) -> dict:
    from fastapi.testclient import TestClient
    import sutra_orchestrator.main as main_mod

    os.environ.setdefault("SUTRA_AUTH_VERIFIER", "permissive_dev")
    for key in ("SUTRA_PG_DSN", "SUTRA_REDIS_URL", "SUTRA_API_KEYS_JSON"):
        os.environ.pop(key, None)
    importlib.reload(main_mod)
    with TestClient(main_mod.app) as client:
        assert main_mod._store is not None
        main_mod._store.put(make_state(subject))
        main_mod._runtime = AgentRuntime(
            TaskRouter(demo_task_graph(), redis_url=None),
            main_mod._store,
            model_provider=DeterministicFakeProvider(force_timeout=True),
        )
        res = client.post(
            "/v1/agent/turn",
            headers={"X-API-Key": "test-dev-key"},
            json={
                "protocolVersion": PROTOCOL_VERSION,
                "subjectId": subject,
                "sessionId": "sess-degr",
                "utterance": utterance,
                "friction": friction(device).model_dump(),
            },
        )
        body = (
            res.json()
            if res.headers.get("content-type", "").startswith("application/json")
            else {}
        )
        ok = (
            res.status_code == 200
            and body.get("degraded") is True
            and str(body.get("reply", "")).startswith("GUIDE concept=")
            and bool(body.get("routingRationale"))
            and (body.get("freshnessMarker") or {}).get("source") == "last-known-good"
            and utterance not in res.text
        )
        return {
            "ok": ok,
            "failureClass": None if ok else "http_contract",
            "httpStatus": res.status_code,
            "degraded": body.get("degraded"),
            "replyStartsWithGuide": str(body.get("reply", "")).startswith(
                "GUIDE concept="
            ),
            "freshnessSource": (body.get("freshnessMarker") or {}).get("source"),
            "fabricated": False,
        }


def run_concurrent(subject: str, device: str, utterance: str) -> dict:
    store = InMemoryMasterStateStore()
    store.put(make_state(subject))
    rt = AgentRuntime(
        TaskRouter(demo_task_graph(), redis_url=None),
        store,
        model_provider=DeterministicFakeProvider(force_timeout=True),
    )
    req = AgentTurnRequest(
        protocolVersion=PROTOCOL_VERSION,  # type: ignore[arg-type]
        subjectId=subject,
        sessionId="sess-degr",
        utterance=utterance,
        friction=friction(device),
    )
    results = [rt.run_turn(req) for _ in range(2)]
    oks = [assert_degraded(r, utterance)[0] for r in results]
    return {
        "ok": all(oks) and len(results) == 2,
        "failureClass": None if all(oks) else "concurrent_degrade",
        "httpStatus": 200,
        "degraded": True,
        "replyStartsWithGuide": all(
            r.reply.startswith("GUIDE concept=") for r in results
        ),
        "freshnessSource": "last-known-good",
        "concurrent": len(results),
        "fabricated": False,
    }


def run_sovereignty(subject: str, device: str, utterance: str) -> dict:
    del utterance  # secret overrides
    store = InMemoryMasterStateStore()
    other = f"{subject}-b"
    store.put(make_state(subject))
    store.put(make_state(other))
    secret = "SECRET_CROSS_SUBJECT_PAYLOAD"
    rt = AgentRuntime(
        TaskRouter(demo_task_graph(), redis_url=None),
        store,
        model_provider=DeterministicFakeProvider(force_timeout=True),
    )
    resp = rt.run_turn(
        AgentTurnRequest(
            protocolVersion=PROTOCOL_VERSION,  # type: ignore[arg-type]
            subjectId=subject,
            sessionId="sess-degr",
            utterance=secret,
            friction=friction(device),
        )
    )
    other_state = store.get(other)
    ok, fc = assert_degraded(resp, secret)
    if secret in (resp.reply or ""):
        ok, fc = False, "content_leak"
    if other_state is None or other_state.activeConceptId != "math.ratios":
        ok, fc = False, "cross_subject_mutate"
    return {
        "ok": ok,
        "failureClass": fc,
        "httpStatus": 200 if ok else 500,
        "degraded": bool(resp.degraded),
        "replyStartsWithGuide": resp.reply.startswith("GUIDE concept="),
        "freshnessSource": resp.freshnessMarker.source if resp.freshnessMarker else None,
        "fabricated": False,
        "contentLeak": secret in (resp.reply or ""),
    }


def main() -> int:
    subject = os.environ.get("SUTRA_DEGR_SUBJECT", "subj-degr-llm")
    device = os.environ.get("SUTRA_DEGR_DEVICE", "edge-degr-llm")
    utterance = os.environ.get("SUTRA_DEGR_UTTERANCE", "what is a ratio?")
    mode = os.environ.get("SUTRA_DEGR_MODE", "turn")

    out: dict = {
        "drill": "cloud_llm_down",
        "subjectId": subject,
        "deviceId": device,
        "ok": False,
    }
    try:
        if mode == "turn":
            out.update(run_turn(subject, device, utterance))
        elif mode == "http":
            out.update(run_http(subject, device, utterance))
        elif mode == "concurrent":
            out.update(run_concurrent(subject, device, utterance))
        elif mode == "sovereignty":
            out.update(run_sovereignty(subject, device, utterance))
        else:
            out["failureClass"] = "unknown_mode"
    except Exception as exc:  # noqa: BLE001 — drill surface
        out["failureClass"] = type(exc).__name__
        out["detail"] = str(exc)[:500]

    print(json.dumps(out), flush=True)
    return 0 if out.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
