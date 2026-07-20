"""Model provider seam — Python twin of ModelInterface (generate only).

``ModelProvider`` protocol + ``DeterministicFakeProvider``.
``assemble_turn_prompt`` (charter + plan + routing) for
``AgentRuntime.run_turn`` → ``provider.generate``.
Smoke_test.py + suite lock fake-provider cloud turns
(no network / API keys; plan context moves digests).

Contract (cloud-simplified vs TS ModelInterface):
  - ``generate(prompt, deadline_ms) -> str`` — prompt is pre-assembled
  - deadline MUST abort with a typed timeout (never hang)
  - empty output MUST fail typed (never silent empty reply)
  - DeterministicFakeProvider output is hash-stable for identical inputs
  - Prompt MUST include active plan step and routingRationale
"""

from __future__ import annotations

import hashlib
import logging
import time
from dataclasses import dataclass, field
from typing import Callable, Protocol, runtime_checkable

from .planner import Plan, format_plan_snapshot

logger = logging.getLogger(__name__)

MODEINVO_OBLIGATION_GENERATE = "MODEINVO-001"
MODEINVO_MUST_GENERATE = (
    "ModelProvider.generate MUST honor deadline_ms, reject empty prompts and "
    "empty outputs with typed errors, and never perform network I/O in the "
    "DeterministicFakeProvider reference mock."
)

MODEINVO_OBLIGATION_TURN = "MODEINVO-002"
MODEINVO_MUST_TURN = (
    "run_turn MUST assemble a prompt from charter, plan active step, and "
    "routingRationale, invoke ModelProvider.generate, and return the model "
    "text as AgentTurnResponse.reply (not a [directive] stub)."
)

# Bound prompt material scanned for hashing / logging (NFR).
PROMPT_HASH_SCAN_LIMIT = 64_000
UTTERANCE_PROMPT_LIMIT = 4_000
CHARTER_PROMPT_LIMIT = 1_200
FAKE_REPLY_MAX_LEN = 512
DEFAULT_GENERATE_DEADLINE_MS = 30_000


class AgentTurnError(Exception):
    """Typed turn failure surfaced to the HTTP layer (never a raw stack)."""

    obligation_id: str = MODEINVO_OBLIGATION_GENERATE
    failure_class: str = "runtime"

    def __init__(
        self,
        message: str,
        *,
        obligation_id: str | None = None,
        failure_class: str | None = None,
    ) -> None:
        super().__init__(message)
        if obligation_id is not None:
            self.obligation_id = obligation_id
        if failure_class is not None:
            self.failure_class = failure_class


class ModelProviderConfigError(AgentTurnError):
    """Provider missing at AgentRuntime / app startup (fail fast)."""

    failure_class = "config"

    def __init__(self, message: str) -> None:
        super().__init__(
            message,
            obligation_id=MODEINVO_OBLIGATION_GENERATE,
            failure_class="config",
        )


class ModelProviderTimeoutError(AgentTurnError):
    """Provider exceeded deadline_ms."""

    failure_class = "timeout"

    def __init__(self, message: str) -> None:
        super().__init__(
            message,
            obligation_id=MODEINVO_OBLIGATION_GENERATE,
            failure_class="timeout",
        )


class ModelProviderEmptyError(AgentTurnError):
    """Provider returned empty / whitespace-only text."""

    failure_class = "validation"

    def __init__(self, message: str) -> None:
        super().__init__(
            message,
            obligation_id=MODEINVO_OBLIGATION_GENERATE,
            failure_class="validation",
        )


class ModelProviderValidationError(AgentTurnError):
    """Invalid generate inputs (empty prompt, non-finite deadline, …)."""

    failure_class = "validation"

    def __init__(self, message: str) -> None:
        super().__init__(
            message,
            obligation_id=MODEINVO_OBLIGATION_GENERATE,
            failure_class="validation",
        )


@runtime_checkable
class ModelProvider(Protocol):
    """Injectable cloud model seam (Python ModelInterface generate slice)."""

    def generate(
        self,
        prompt: str,
        deadline_ms: int,
        *,
        subject_id: str = "",
        device_id: str = "",
    ) -> str:
        """Return non-empty model text within ``deadline_ms`` wall-clock budget."""
        ...


def require_model_provider(provider: ModelProvider | None) -> ModelProvider:
    """Fail fast when production/runtime config omits a provider binding."""
    if provider is None:
        raise ModelProviderConfigError(
            "ModelProvider is required at AgentRuntime construction "
            "(inject DeterministicFakeProvider in tests; a real provider in prod)"
        )
    if not callable(getattr(provider, "generate", None)):
        raise ModelProviderConfigError(
            "ModelProvider binding missing generate() — not a valid provider"
        )
    return provider


def validate_generate_inputs(
    prompt: str,
    deadline_ms: int,
    *,
    subject_id: str = "",
) -> tuple[str, int]:
    """Boundary validation before any provider work."""
    if not isinstance(prompt, str) or not prompt.strip():
        raise ModelProviderValidationError(
            "generate prompt must be a non-empty string"
        )
    if not isinstance(deadline_ms, int) or isinstance(deadline_ms, bool):
        raise ModelProviderValidationError(
            "deadline_ms must be a positive int"
        )
    if deadline_ms <= 0:
        # Zero / negative budget is an immediate timeout, not a hang.
        raise ModelProviderTimeoutError(
            f"generate deadline_ms={deadline_ms} already elapsed"
        )
    sid = (subject_id or "").strip()
    if not sid:
        # Sovereignty: every generate is subject-scoped.
        raise ModelProviderValidationError(
            "generate requires subject_id (subject isolation)"
        )
    return prompt, deadline_ms


def validate_generate_output(text: str) -> str:
    """Reject silent empty replies after provider returns."""
    if not isinstance(text, str) or not text.strip():
        raise ModelProviderEmptyError(
            "ModelProvider.generate returned empty text"
        )
    return text


def stable_prompt_digest(
    prompt: str,
    *,
    subject_id: str,
    device_id: str = "",
) -> str:
    """Hash-stable digest for golden replies — metadata length, never raw content logs."""
    material = "\n".join(
        [
            f"subject={subject_id.strip()}",
            f"device={(device_id or '').strip()}",
            prompt[:PROMPT_HASH_SCAN_LIMIT],
        ]
    )
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def default_charter_for_profile(*, track: str, language: str, age_band: str) -> str:
    """Domain-light charter from CognitiveState.profile (no learner content)."""
    t = (track or "").strip() or "general"
    lang = (language or "").strip() or "en"
    band = (age_band or "").strip() or "adult"
    return (
        f"You are an autonomous cognitive agent for track '{t}' "
        f"(language={lang}, ageBand={band}). Ground replies in the plan "
        f"active step and routing rationale; stay within scope of practice."
    )[:CHARTER_PROMPT_LIMIT]


def assemble_turn_prompt(
    *,
    charter: str,
    age_band: str,
    track: str,
    language: str,
    mode: str,
    guidance_directive: str,
    routing_rationale: str,
    plan: Plan,
    utterance: str,
) -> str:
    """Assemble the model prompt: charter + plan + routing."""
    charter_text = (charter or "").strip() or default_charter_for_profile(
        track=track, language=language, age_band=age_band
    )
    plan_snapshot = format_plan_snapshot(plan)
    active = next((s for s in plan.steps if s.status == "active"), None)
    if active is None:
        active = next((s for s in plan.steps if s.status == "pending"), None)
    active_step = (
        f"{active.step_id}:{active.action}" if active is not None else "none"
    )
    user_text = (utterance or "").strip()[:UTTERANCE_PROMPT_LIMIT] or "(no utterance)"
    return "\n".join(
        [
            "### system",
            charter_text,
            f"profile: ageBand={age_band}; track={track}; language={language}",
            "### plan",
            f"[plan] {plan_snapshot}",
            f"active_step: {active_step}",
            "### route",
            f"mode={mode}",
            f"directive: {guidance_directive}",
            f"rationale: {routing_rationale}",
            "### user",
            user_text,
        ]
    )


@dataclass
class DeterministicFakeProvider:
    """Hash-stable offline provider for CI / golden tests.

    Never opens sockets or reads API keys. Identical (prompt, subject, device)
    tuples always yield the same reply text.
    """

    locality: str = "self-hosted"
    model_id: str = "deterministic-fake"
    # Test hooks — not for production.
    force_timeout: bool = False
    force_empty: bool = False
    # Simulates work under deadline (ms); 0 = immediate.
    work_ms: int = 0
    _calls: int = field(default=0, init=False, repr=False)
    last_prompt: str | None = field(default=None, init=False, repr=False)

    def generate(
        self,
        prompt: str,
        deadline_ms: int,
        *,
        subject_id: str = "",
        device_id: str = "",
    ) -> str:
        started = time.monotonic()
        prompt, deadline_ms = validate_generate_inputs(
            prompt, deadline_ms, subject_id=subject_id
        )
        self.last_prompt = prompt
        sid = subject_id.strip()
        did = (device_id or "").strip()

        if self.force_timeout:
            logger.info(
                "model_provider subject_id=%s device_id=%s op=generate "
                "outcome=timeout model_id=%s",
                sid,
                did or "-",
                self.model_id,
            )
            raise ModelProviderTimeoutError(
                f"DeterministicFakeProvider forced timeout (deadline_ms={deadline_ms})"
            )

        if self.work_ms > 0:
            # Bound sleep so tests cannot hang the suite.
            sleep_s = min(self.work_ms, deadline_ms) / 1000.0
            time.sleep(sleep_s)

        elapsed_ms = int((time.monotonic() - started) * 1000)
        if elapsed_ms >= deadline_ms:
            logger.info(
                "model_provider subject_id=%s device_id=%s op=generate "
                "outcome=timeout model_id=%s",
                sid,
                did or "-",
                self.model_id,
            )
            raise ModelProviderTimeoutError(
                f"DeterministicFakeProvider exceeded deadline_ms={deadline_ms}"
            )

        if self.force_empty:
            logger.info(
                "model_provider subject_id=%s device_id=%s op=generate "
                "outcome=empty model_id=%s",
                sid,
                did or "-",
                self.model_id,
            )
            # Resolve only after "side effect" flag accounting (durable-before-resolve).
            self._calls += 1
            return validate_generate_output("")

        digest = stable_prompt_digest(prompt, subject_id=sid, device_id=did)
        # Grounding marker keeps router/plan tokens distinguishable in goldens
        # without echoing the full prompt (sovereignty / no content dump).
        reply = (
            f"[fake:{self.model_id}] digest={digest[:16]} "
            f"prompt_chars={min(len(prompt), PROMPT_HASH_SCAN_LIMIT)} "
            f"locality={self.locality}"
        )[:FAKE_REPLY_MAX_LEN]

        # Durable call accounting before resolve.
        self._calls += 1
        text = validate_generate_output(reply)
        logger.info(
            "model_provider subject_id=%s device_id=%s op=generate "
            "outcome=ok model_id=%s locality=%s",
            sid,
            did or "-",
            self.model_id,
            self.locality,
        )
        return text

    @property
    def call_count(self) -> int:
        return self._calls


@dataclass(frozen=True)
class ModelProviderConformanceVerdict:
    obligation_id: str
    must_text: str
    passed: bool
    message: str = ""


@dataclass(frozen=True)
class ModelProviderConformanceReport:
    verdicts: tuple[ModelProviderConformanceVerdict, ...]

    @property
    def exit_code(self) -> int:
        return 0 if all(v.passed for v in self.verdicts) else 1

    @property
    def passed_count(self) -> int:
        return sum(1 for v in self.verdicts if v.passed)


def run_model_provider_conformance(
    provider: ModelProvider,
    *,
    subject_id: str,
    device_id: str = "dev-modeinvo",
    emit: Callable[[dict[str, object]], None] | None = None,
) -> ModelProviderConformanceReport:
    """Conformance gate for ModelProvider mocks."""
    sid = (subject_id or "").strip()
    if not sid:
        raise ModelProviderValidationError(
            "run_model_provider_conformance requires subject_id"
        )

    verdicts: list[ModelProviderConformanceVerdict] = []

    def _add(passed: bool, message: str = "") -> None:
        v = ModelProviderConformanceVerdict(
            obligation_id=MODEINVO_OBLIGATION_GENERATE,
            must_text=MODEINVO_MUST_GENERATE,
            passed=passed,
            message=message,
        )
        verdicts.append(v)
        emit and emit(
            {
                "event": "conformance.model_provider",
                "subjectId": sid,
                "deviceId": device_id,
                "obligationId": v.obligation_id,
                "outcome": "pass" if passed else "fail",
            }
        )
        logger.info(
            "model_provider_conformance subject_id=%s obligation=%s outcome=%s",
            sid,
            v.obligation_id,
            "pass" if passed else "fail",
        )

    prompt = (
        f"### system\ncharter=probe\n### plan\nstep=s1\n"
        f"### route\nrationale=probe.modeinvo.{sid}\n### user\nprobe"
    )

    # 1) Happy path non-empty.
    try:
        text_a = provider.generate(
            prompt, DEFAULT_GENERATE_DEADLINE_MS, subject_id=sid, device_id=device_id
        )
        if not text_a.strip():
            _add(False, "generate returned empty on happy path")
        else:
            _add(True)
    except Exception as err:  # noqa: BLE001
        _add(False, f"generate threw: {err}")

    # 2) Hash-stable replay.
    try:
        text_b = provider.generate(
            prompt, DEFAULT_GENERATE_DEADLINE_MS, subject_id=sid, device_id=device_id
        )
        text_a2 = provider.generate(
            prompt, DEFAULT_GENERATE_DEADLINE_MS, subject_id=sid, device_id=device_id
        )
        if text_b != text_a2:
            _add(False, "identical inputs did not yield identical outputs")
        else:
            _add(True)
    except Exception as err:  # noqa: BLE001
        _add(False, f"stability probe threw: {err}")

    # 3) Subject isolation — different subject ⇒ different digest/reply.
    try:
        other = provider.generate(
            prompt,
            DEFAULT_GENERATE_DEADLINE_MS,
            subject_id=f"{sid}.peer",
            device_id=device_id,
        )
        same = provider.generate(
            prompt, DEFAULT_GENERATE_DEADLINE_MS, subject_id=sid, device_id=device_id
        )
        if other == same:
            _add(False, "distinct subject_id produced identical reply")
        else:
            _add(True)
    except Exception as err:  # noqa: BLE001
        _add(False, f"isolation probe threw: {err}")

    # 4) Deadline zero → typed timeout.
    try:
        provider.generate(prompt, 0, subject_id=sid, device_id=device_id)
        _add(False, "deadline_ms=0 did not raise ModelProviderTimeoutError")
    except ModelProviderTimeoutError:
        _add(True)
    except Exception as err:  # noqa: BLE001
        _add(False, f"deadline probe wrong error: {err}")

    # 5) Empty prompt → typed validation.
    try:
        provider.generate("   ", 1_000, subject_id=sid, device_id=device_id)
        _add(False, "empty prompt did not raise ModelProviderValidationError")
    except ModelProviderValidationError:
        _add(True)
    except Exception as err:  # noqa: BLE001
        _add(False, f"empty-prompt probe wrong error: {err}")

    return ModelProviderConformanceReport(verdicts=tuple(verdicts))
