"""ModelProvider protocol + DeterministicFakeProvider.

Reference mock: hash-stable, offline, deadline-aware; no API keys / network.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

import pytest

from sutra_orchestrator.agent_runtime import AgentRuntime
from sutra_orchestrator.model_provider import (
    MODEINVO_MUST_GENERATE,
    MODEINVO_OBLIGATION_GENERATE,
    DeterministicFakeProvider,
    ModelProviderConfigError,
    ModelProviderEmptyError,
    ModelProviderTimeoutError,
    ModelProviderValidationError,
    require_model_provider,
    run_model_provider_conformance,
    stable_prompt_digest,
    validate_generate_output,
)
from sutra_orchestrator.sync_service import InMemoryMasterStateStore
from sutra_orchestrator.task_router import TaskRouter, demo_task_graph


# ── Conformance suite (100% against the mock) ────────────────────────────────


def test_conformance_suite_passes_100_percent_against_fake() -> None:
    events: list[dict[str, object]] = []
    report = run_model_provider_conformance(
        DeterministicFakeProvider(),
        subject_id="subj-mp-conf",
        device_id="dev-mp",
        emit=events.append,
    )
    assert report.exit_code == 0
    assert report.passed_count == len(report.verdicts)
    assert report.passed_count >= 5
    assert all(v.obligation_id == MODEINVO_OBLIGATION_GENERATE for v in report.verdicts)
    assert all(v.must_text == MODEINVO_MUST_GENERATE for v in report.verdicts)
    assert all(e["outcome"] == "pass" for e in events)
    assert all(e["subjectId"] == "subj-mp-conf" for e in events)


# ── Happy path + edges ───────────────────────────────────────────────────────


def test_happy_path_hash_stable_identical_inputs() -> None:
    fake = DeterministicFakeProvider()
    prompt = "### plan\nstep=s1\n### route\nr=continue\n### user\nprobe"
    a = fake.generate(prompt, 5_000, subject_id="subj-stable", device_id="d1")
    b = fake.generate(prompt, 5_000, subject_id="subj-stable", device_id="d1")
    assert a == b
    assert a.startswith("[fake:deterministic-fake]")
    assert "digest=" in a
    assert fake.call_count == 2


def test_edge_timeout_typed_error() -> None:
    fake = DeterministicFakeProvider(force_timeout=True)
    with pytest.raises(ModelProviderTimeoutError) as exc:
        fake.generate("prompt body", 1_000, subject_id="subj-to")
    assert exc.value.obligation_id == MODEINVO_OBLIGATION_GENERATE
    assert exc.value.failure_class == "timeout"

    with pytest.raises(ModelProviderTimeoutError):
        fake.generate("prompt body", 0, subject_id="subj-to")


def test_edge_empty_output_typed_error() -> None:
    fake = DeterministicFakeProvider(force_empty=True)
    with pytest.raises(ModelProviderEmptyError) as exc:
        fake.generate("non-empty prompt", 1_000, subject_id="subj-empty")
    assert exc.value.failure_class == "validation"
    # Durable-before-resolve: call accounted even when output rejected.
    assert fake.call_count == 1

    with pytest.raises(ModelProviderEmptyError):
        validate_generate_output("   ")


def test_edge_missing_provider_fail_fast_at_construction() -> None:
    store = InMemoryMasterStateStore()
    router = TaskRouter(demo_task_graph(), redis_url=None)
    with pytest.raises(ModelProviderConfigError) as exc:
        AgentRuntime(
            router,
            store,
            require_model_provider_binding=True,
        )
    assert "ModelProvider is required" in str(exc.value)

    with pytest.raises(ModelProviderConfigError):
        require_model_provider(None)

    rt = AgentRuntime(
        router,
        store,
        model_provider=DeterministicFakeProvider(),
        require_model_provider_binding=True,
    )
    assert rt.model_provider is not None
    assert rt.require_model_provider() is rt.model_provider


def test_sovereignty_subject_scoped_digests_and_events() -> None:
    fake = DeterministicFakeProvider()
    prompt = "shared prompt text"
    a = fake.generate(prompt, 2_000, subject_id="subj-a", device_id="dev")
    b = fake.generate(prompt, 2_000, subject_id="subj-b", device_id="dev")
    assert a != b
    da = stable_prompt_digest(prompt, subject_id="subj-a", device_id="dev")
    db = stable_prompt_digest(prompt, subject_id="subj-b", device_id="dev")
    assert da != db
    # Reply embeds digest prefix only — not raw prompt / utterance bodies.
    assert "shared prompt text" not in a
    assert "shared prompt text" not in b

    with pytest.raises(ModelProviderValidationError):
        fake.generate(prompt, 1_000, subject_id="")


def test_concurrent_generate_is_deterministic_and_race_free() -> None:
    fake = DeterministicFakeProvider()
    prompt = "concurrent probe"
    results: list[str] = []

    def once(_: int) -> None:
        results.append(
            fake.generate(prompt, 5_000, subject_id="subj-conc", device_id="d")
        )

    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(once, range(12)))

    assert len(results) == 12
    assert len(set(results)) == 1
    assert fake.call_count == 12


def test_agent_runtime_defaults_to_deterministic_fake_when_unbound() -> None:
    """Unbound construction uses DeterministicFakeProvider."""
    store = InMemoryMasterStateStore()
    rt = AgentRuntime(TaskRouter(demo_task_graph(), redis_url=None), store)
    assert isinstance(rt.model_provider, DeterministicFakeProvider)
