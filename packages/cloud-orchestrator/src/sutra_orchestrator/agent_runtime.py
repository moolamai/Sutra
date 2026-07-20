"""Agent runtime — composes router, state store, planner, and memory into turns.

The cloud-side execution engine, isolated from HTTP concerns. One turn:

    1. Load the subject's master cognitive state.
    2. Route through the cyclical task router (assess friction, loop back
       through weak prerequisites, or advance).
    3. Bind GraphPlanner: compose on first guidance; blocking revise on
       router loop-back; informational revise or retarget compose otherwise;
       attach plan snapshot to turn context.
    4. Persist routing fields (+ plan attachment) on MasterStateStore.
    5. Assemble prompt (charter + plan + routing) and invoke ModelProvider;
       return model text as AgentTurnResponse.reply.
       Smoke-locked by smoke_test.py + DeterministicFakeProvider.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass

from . import PROTOCOL_VERSION
from .contract_models import AgentTurnRequest, AgentTurnResponse, CognitiveState, FreshnessMarker
from .model_provider import (
    DEFAULT_GENERATE_DEADLINE_MS,
    MODEINVO_MUST_TURN,
    MODEINVO_OBLIGATION_TURN,
    DeterministicFakeProvider,
    ModelProvider,
    ModelProviderTimeoutError,
    ModelProviderValidationError,
    assemble_turn_prompt,
    default_charter_for_profile,
    require_model_provider,
)
from .planner import (
    PLANBIND_OBLIGATION_LOOPBACK,
    PLANBIND_OBLIGATION_WIRE,
    GraphPlanner,
    Plan,
    PlanRevisionEvent,
    assert_loopback_blocking_revision,
    assert_plan_bound_in_turn_context,
    is_router_loop_back,
    plan_has_pending_steps,
    resolve_blocking_step_id,
    seed_goals_from_routing,
)
from .sync_service import MasterStateStore
from .task_router import TaskRouter
from .trajectory_capture import TurnTrajectoryCaptureHook

logger = logging.getLogger(__name__)


class UnknownSubjectError(Exception):
    """No cognitive state exists for the subject; the edge must sync first."""


@dataclass
class _SubjectPlanSlot:
    """Per-subject attached plan field (survives turns; mirrored via store)."""

    plan: Plan
    concept_id: str


# Attribute on MasterStateStore holding plan slots across AgentRuntime restarts.
_PLAN_SIDECAR_ATTR = "_sutra_plan_slots"


def _plan_slots_for(store: MasterStateStore) -> dict[str, _SubjectPlanSlot]:
    """Process-local plan sidecar on the store ( restart survival)."""
    slots = getattr(store, _PLAN_SIDECAR_ATTR, None)
    if not isinstance(slots, dict):
        slots = {}
        setattr(store, _PLAN_SIDECAR_ATTR, slots)
    return slots


class AgentRuntime:
    """Per-deployment execution engine. Cognitive state lives in the master
    store; per-subject plan slots attach the active GraphPlanner plan and
    survive AgentRuntime reconstruction when the same store instance is kept.
    """

    def __init__(
        self,
        router: TaskRouter,
        store: MasterStateStore,
        planner: GraphPlanner | None = None,
        model_provider: ModelProvider | None = None,
        *,
        require_model_provider_binding: bool = False,
        trajectory_capture_hook: TurnTrajectoryCaptureHook | None = None,
    ) -> None:
        self._router = router
        self._store = store
        self._planner = planner if planner is not None else GraphPlanner()
        # Every turn invokes generate — unbound defaults to the
        # offline fake so the reference engine stays CI-safe without keys.
        if require_model_provider_binding:
            self._model_provider = require_model_provider(model_provider)
        elif model_provider is not None:
            self._model_provider = model_provider
        else:
            self._model_provider = DeterministicFakeProvider()
        self._trajectory_capture_hook = trajectory_capture_hook
        self._plans = _plan_slots_for(store)
        self._subject_locks: dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()
        logger.info(
            "agent_runtime_init model_provider=%s outcome=ok",
            type(self._model_provider).__name__,
        )

    def get_state(self, subject_id: str) -> CognitiveState | None:
        return self._store.get(subject_id)

    def get_active_plan(self, subject_id: str) -> Plan | None:
        """Attached plan for the subject (PLANBIND survival surface)."""
        slot = self._plans.get(subject_id)
        return slot.plan if slot else None

    @property
    def model_provider(self) -> ModelProvider:
        """Bound ModelProvider (always set after construction)."""
        return self._model_provider

    def require_model_provider(self) -> ModelProvider:
        """Fail fast when a host cleared/replaced the binding incorrectly."""
        return require_model_provider(self._model_provider)

    def _lock_for(self, subject_id: str) -> threading.Lock:
        with self._locks_guard:
            lock = self._subject_locks.get(subject_id)
            if lock is None:
                lock = threading.Lock()
                self._subject_locks[subject_id] = lock
            return lock

    def run_turn(self, request: AgentTurnRequest) -> AgentTurnResponse:
        state = self._store.get(request.subjectId)
        if state is None:
            raise UnknownSubjectError(
                f"no cognitive state for subject '{request.subjectId}'; sync first"
            )

        with self._lock_for(request.subjectId):
            return self._run_turn_locked(request, state)

    def _run_turn_locked(
        self, request: AgentTurnRequest, state: CognitiveState
    ) -> AgentTurnResponse:
        active = state.activeConceptId or request.friction.conceptId
        result = self._router.route_turn(
            subject_id=request.subjectId,
            active_concept_id=active,
            mode=state.mode,
            friction=request.friction,
            mastery=state.mastery,
            session_id=request.sessionId,
        )

        prior_plan = self.get_active_plan(request.subjectId)
        plan, plan_op = self._bind_planner(
            subject_id=request.subjectId,
            next_concept_id=result["next_concept_id"],
            mode=result["mode"],
            guidance_directive=result["guidance_directive"],
            routing_rationale=result["routing_rationale"],
        )

        # Persist routing outcome on cognitive state (MasterStateStore).
        persisted = self._persist_cognitive_routing(
            state,
            next_concept_id=result["next_concept_id"],
            mode=result["mode"],
        )

        if (
            prior_plan is not None
            and is_router_loop_back(
                mode=result["mode"],
                routing_rationale=result["routing_rationale"],
            )
            and plan_op == "revise_blocking_loopback"
        ):
            assert_loopback_blocking_revision(
                prior=prior_plan,
                revised=plan,
                mode=result["mode"],
                routing_rationale=result["routing_rationale"],
                persisted_mode=persisted.mode,
                persisted_concept_id=persisted.activeConceptId,
                expected_concept_id=result["next_concept_id"],
            )

        mastery_entry = persisted.mastery.get(result["next_concept_id"])
        estimate = mastery_entry.mastery_mean if mastery_entry else 0.5

        profile = persisted.profile
        prompt = assemble_turn_prompt(
            charter=default_charter_for_profile(
                track=profile.track,
                language=profile.language,
                age_band=profile.ageBand,
            ),
            age_band=profile.ageBand,
            track=profile.track,
            language=profile.language,
            mode=result["mode"],
            guidance_directive=result["guidance_directive"],
            routing_rationale=result["routing_rationale"],
            plan=plan,
            utterance=request.utterance,
        )
        # Plan grounding is required in the prompt (turn context for the model).
        assert_plan_bound_in_turn_context(context=prompt, plan=plan)
        if "active_step:" not in prompt or "rationale:" not in prompt:
            raise ModelProviderValidationError(MODEINVO_MUST_TURN)

        device_id = persisted.deviceIds[0] if persisted.deviceIds else ""
        provider = self.require_model_provider()
        # Durable routing persist already completed — generate may still timeout.
        try:
            reply = provider.generate(
                prompt,
                DEFAULT_GENERATE_DEADLINE_MS,
                subject_id=request.subjectId,
                device_id=device_id,
            )
        except ModelProviderTimeoutError:
            # ATR-05: directive itself is a valid degraded reply (not 5xx).
            marker = _freshness_marker_now(device_id or "cloud-orch")
            logger.info(
                "agent_turn subject_id=%s device_id=%s plan_id=%s op=generate "
                "outcome=degraded failure_class=timeout signal=DEGRADE_STALE_READ "
                "freshness_source=%s obligation=%s",
                request.subjectId,
                device_id or "-",
                plan.plan_id,
                marker.source,
                MODEINVO_OBLIGATION_TURN,
            )
            response = AgentTurnResponse(
                protocolVersion=PROTOCOL_VERSION,  # type: ignore[arg-type]
                reply=result["guidance_directive"],
                nextConceptId=result["next_concept_id"],
                mode=result["mode"],
                routingRationale=result["routing_rationale"],
                masteryEstimate=round(estimate, 4),
                degraded=True,
                freshnessMarker=marker,
            )
            self._capture_after_reflect(
                request=request,
                device_id=device_id,
                prompt=prompt,
                response=response,
                provider=provider,
            )
            return response
        except Exception:
            logger.info(
                "agent_turn subject_id=%s device_id=%s plan_id=%s op=generate "
                "outcome=error obligation=%s",
                request.subjectId,
                device_id or "-",
                plan.plan_id,
                MODEINVO_OBLIGATION_TURN,
            )
            raise

        obligation = (
            PLANBIND_OBLIGATION_LOOPBACK
            if plan_op == "revise_blocking_loopback"
            else PLANBIND_OBLIGATION_WIRE
        )
        logger.info(
            "agent_turn subject_id=%s device_id=%s plan_id=%s op=%s "
            "mode=%s concept=%s outcome=ok obligation=%s model_obligation=%s",
            request.subjectId,
            device_id or "-",
            plan.plan_id,
            plan_op,
            result["mode"],
            result["next_concept_id"],
            obligation,
            MODEINVO_OBLIGATION_TURN,
        )

        response = AgentTurnResponse(
            protocolVersion=PROTOCOL_VERSION,  # type: ignore[arg-type]
            reply=reply,
            nextConceptId=result["next_concept_id"],
            mode=result["mode"],
            routingRationale=result["routing_rationale"],
            masteryEstimate=round(estimate, 4),
        )
        self._capture_after_reflect(
            request=request,
            device_id=device_id,
            prompt=prompt,
            response=response,
            provider=provider,
        )
        return response

    def _capture_after_reflect(
        self,
        *,
        request: AgentTurnRequest,
        device_id: str,
        prompt: str,
        response: AgentTurnResponse,
        provider: ModelProvider,
    ) -> None:
        """Admit metadata after the completed cloud turn; never fail the reply."""
        hook = self._trajectory_capture_hook
        if hook is None:
            return
        try:
            hook.capture_after_reflect(
                subject_id=request.subjectId,
                device_id=device_id or "cloud",
                session_id=request.sessionId,
                captured_at=str(request.friction.capturedAt),
                prompt=prompt,
                reply=response.reply,
                model_id=type(provider).__name__,
                declined=False,
            )
        except Exception as error:
            logger.exception(
                "trajectory_hook outcome=rejected subject_id=%s device_id=%s "
                "failure_class=%s",
                request.subjectId,
                device_id or "cloud",
                type(error).__name__[:64],
            )

    def _persist_cognitive_routing(
        self,
        state: CognitiveState,
        *,
        next_concept_id: str,
        mode: str,
    ) -> CognitiveState:
        """Write routing fields after planner bind (durable cognitive state)."""
        updated = state.model_copy(
            update={
                "activeConceptId": next_concept_id,
                "mode": mode,
            }
        )
        self._store.put(updated)
        logger.info(
            "cognitive_state_persist subject_id=%s concept=%s mode=%s outcome=ok",
            updated.subjectId,
            next_concept_id,
            mode,
        )
        return updated

    def _bind_planner(
        self,
        *,
        subject_id: str,
        next_concept_id: str,
        mode: str,
        guidance_directive: str,
        routing_rationale: str,
    ) -> tuple[Plan, str]:
        """Compose or revise after routing; attach plan per subject."""
        prior = self._plans.get(subject_id)
        context = f"concept={next_concept_id};mode={mode}"
        loop_back = is_router_loop_back(
            mode=mode, routing_rationale=routing_rationale
        )

        if prior is None:
            goals = seed_goals_from_routing(
                concept_id=next_concept_id,
                guidance_directive=guidance_directive,
            )
            plan = self._planner.compose(goals, context)
            self._plans[subject_id] = _SubjectPlanSlot(
                plan=plan, concept_id=next_concept_id
            )
            logger.info(
                "planner_bind subject_id=%s plan_id=%s op=compose outcome=ok",
                subject_id,
                plan.plan_id,
            )
            return plan, "compose"

        if loop_back:
            # Blocking revise on router loop-back / remediation.
            step_id = resolve_blocking_step_id(prior.plan)
            if step_id is None:
                # Degenerate empty plan — compose seed rather than hang.
                goals = seed_goals_from_routing(
                    concept_id=next_concept_id,
                    guidance_directive=guidance_directive,
                )
                plan = self._planner.compose(goals, f"{context};loopback_empty_prior")
                self._plans[subject_id] = _SubjectPlanSlot(
                    plan=plan, concept_id=next_concept_id
                )
                logger.info(
                    "planner_bind subject_id=%s plan_id=%s op=compose "
                    "outcome=loopback_empty_prior",
                    subject_id,
                    plan.plan_id,
                )
                return plan, "compose"

            observation = (
                f"router loop-back mode={mode} "
                f"from={prior.concept_id} to={next_concept_id} "
                f"pending={plan_has_pending_steps(prior.plan)}"
            )
            plan = self._planner.revise(
                prior.plan,
                PlanRevisionEvent(
                    observation=observation,
                    step_id=step_id,
                    severity="blocking",
                ),
            )
            self._plans[subject_id] = _SubjectPlanSlot(
                plan=plan, concept_id=next_concept_id
            )
            logger.info(
                "planner_bind subject_id=%s plan_id=%s op=revise "
                "outcome=blocking_loopback step_id=%s obligation=%s",
                subject_id,
                plan.plan_id,
                step_id,
                PLANBIND_OBLIGATION_LOOPBACK,
            )
            return plan, "revise_blocking_loopback"

        if prior.concept_id != next_concept_id:
            # Non-loop-back retarget (advance) — abandon then compose.
            observation = (
                f"router retarget {prior.concept_id}->{next_concept_id} "
                f"mode={mode}; pending={plan_has_pending_steps(prior.plan)}"
            )
            abandoned = self._planner.revise(
                prior.plan,
                PlanRevisionEvent(observation=observation, severity="invalidating"),
            )
            logger.info(
                "planner_bind subject_id=%s plan_id=%s op=revise outcome=abandon_retarget "
                "from_concept=%s to_concept=%s",
                subject_id,
                abandoned.plan_id,
                prior.concept_id,
                next_concept_id,
            )
            goals = seed_goals_from_routing(
                concept_id=next_concept_id,
                guidance_directive=guidance_directive,
            )
            plan = self._planner.compose(
                goals, f"{context};after_retarget_from={prior.concept_id}"
            )
            self._plans[subject_id] = _SubjectPlanSlot(
                plan=plan, concept_id=next_concept_id
            )
            logger.info(
                "planner_bind subject_id=%s plan_id=%s op=compose outcome=ok",
                subject_id,
                plan.plan_id,
            )
            return plan, "compose_after_retarget"

        plan = self._planner.revise(
            prior.plan,
            PlanRevisionEvent(
                observation=f"router continue mode={mode}",
                severity="informational",
            ),
        )
        self._plans[subject_id] = _SubjectPlanSlot(
            plan=plan, concept_id=next_concept_id
        )
        logger.info(
            "planner_bind subject_id=%s plan_id=%s op=revise outcome=ok",
            subject_id,
            plan.plan_id,
        )
        return plan, "revise"


def _freshness_marker_now(device_id: str) -> FreshnessMarker:
    """Mint a last-known-good freshness marker (HLC-shaped opaque clock)."""
    safe = "".join(c if c.isalnum() or c in "_-" else "-" for c in device_id)[:64]
    if len(safe) < 4:
        safe = "cloud-orch"
    physical_ms = int(time.time() * 1000)
    captured = f"{physical_ms:015d}:000000:{safe}"
    return FreshnessMarker(capturedAt=captured, source="last-known-good")
