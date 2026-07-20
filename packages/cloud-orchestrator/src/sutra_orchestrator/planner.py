"""Graph planner — goal decomposition over a prerequisite DAG.

The Python twin of the planning contract in ``@moolam/contracts``
(``planning.ts``): compose a plan from goals, revise it under new
evidence, expose the next actionable step. Plans are cyclic-capable by
contract: a revision may route BACK to earlier goals when evidence shows
a foundation is weak.

This reference planner is deliberately simple (topological order over the
goal DAG). Deployments bind richer planners (HTN, LLM-composed, domain
rule engines) behind the same shape.

Helpers for agent_runtime wiring (seed goals from routing
directive; plan snapshot for turn / prompt context; typed cycle error).
Loop-back detection; blocking revise obligation helpers.
Python CK-08 conformance port (parity with the TS planning twin).
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field, replace
from typing import Callable, Literal, Protocol

logger = logging.getLogger(__name__)

StepStatus = Literal["pending", "active", "done", "blocked", "abandoned"]
RevisionSeverity = Literal["informational", "blocking", "invalidating"]

# Verbatim contract obligations (CK-08) from @moolam/contracts planning.ts.
MUST_CYCLIC_REVISE = (
    "Plans MUST be cyclic-capable: `revise` may route BACK to earlier goals "
    "when evidence shows a foundation is weak (the loop-back property, valid "
    "in any domain)."
)
MUST_REVISION_UPDATES_RATIONALE = (
    "Every revision MUST update `rationale`; silent plan mutation is a "
    "contract violation."
)

PLANBIND_OBLIGATION_WIRE = "PLANBIND-001"
PLANBIND_MUST_WIRE = (
    "After task_router.route_turn, run_turn MUST call GraphPlanner.compose "
    "or revise based on routing outcome and attach the plan snapshot to "
    "turn context."
)

PLANBIND_OBLIGATION_LOOPBACK = "PLANBIND-002"
PLANBIND_MUST_LOOPBACK = (
    "When router returns loop-back mode, run_turn MUST invoke "
    "planner.revise with blocking severity and persist the updated plan "
    "on cognitive state."
)

ROUTER_LOOPBACK_MODE = "prerequisite-remediation"

# Bound sizes (NFR) — never scan unbounded plan/goal lists on the hot path.
PLAN_STEP_CONTEXT_LIMIT = 16
GOAL_SEED_DESC_LIMIT = 240


class PlannerCycleError(ValueError):
    """Malformed goal DAG: cycle detected during compose (typed, not hang)."""

    obligation_id = "CK-08.1"
    failure_class = "validation"

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.obligation_id = PlannerCycleError.obligation_id
        self.failure_class = PlannerCycleError.failure_class


class PlannerObligationError(ValueError):
    """Planner-binding contract surface failed a named obligation."""

    def __init__(self, message: str, *, obligation_id: str) -> None:
        super().__init__(message)
        self.obligation_id = obligation_id
        self.failure_class = "contract"


@dataclass(frozen=True)
class Goal:
    goal_id: str
    description: str
    prerequisites: tuple[str, ...] = ()
    success_criterion: str = ""


@dataclass(frozen=True)
class PlanStep:
    step_id: str
    goal_id: str
    action: str
    depends_on: tuple[str, ...] = ()
    status: StepStatus = "pending"


@dataclass(frozen=True)
class Plan:
    plan_id: str
    steps: tuple[PlanStep, ...]
    rationale: str


@dataclass(frozen=True)
class PlanRevisionEvent:
    observation: str
    step_id: str | None = None
    severity: RevisionSeverity = "informational"


@dataclass
class GraphPlanner:
    """Composes plans by topologically ordering the goal DAG.

    Contract obligations honored:
      1. cyclic-capable: an ``invalidating`` revision reactivates the
         earliest prerequisite step of the affected goal (loop-back).
      2. every revision rewrites ``rationale``; plans never mutate silently.
    """

    _sequence: int = field(default=0)

    def compose(self, goals: list[Goal], context: str) -> Plan:
        try:
            ordered = self._topological(goals)
        except ValueError as err:
            msg = str(err)
            if "cycle" in msg.lower():
                raise PlannerCycleError(msg) from err
            raise
        steps = tuple(
            PlanStep(
                step_id=f"s{i + 1}",
                goal_id=g.goal_id,
                action=f"Work toward: {g.description}",
                depends_on=(f"s{i}",) if i > 0 else (),
                status="active" if i == 0 else "pending",
            )
            for i, g in enumerate(ordered)
        )
        self._sequence += 1
        return Plan(
            plan_id=f"plan-{self._sequence}",
            steps=steps,
            rationale=f"Topological order over {len(goals)} goal(s) for context: {context}",
        )

    def revise(self, plan: Plan, event: PlanRevisionEvent) -> Plan:
        prior_rationale = plan.rationale
        if event.severity == "informational":
            revised = replace(
                plan, rationale=f"{plan.rationale} | noted: {event.observation}"
            )
        elif event.severity == "blocking" and event.step_id:
            steps = tuple(
                replace(s, status="blocked") if s.step_id == event.step_id else s
                for s in plan.steps
            )
            revised = replace(
                plan,
                steps=steps,
                rationale=f"{plan.rationale} | blocked {event.step_id}: {event.observation}",
            )
        else:
            # Invalidating: loop back. Reactivate the earliest not-done step and
            # reset everything after it, because its foundations are in doubt.
            first_open = next(
                (i for i, s in enumerate(plan.steps) if s.status != "done"), 0
            )
            loop_to = max(0, first_open - 1)
            steps = tuple(
                replace(
                    s,
                    status=(
                        "active"
                        if i == loop_to
                        else ("done" if i < loop_to else "pending")
                    ),
                )
                for i, s in enumerate(plan.steps)
            )
            revised = replace(
                plan,
                steps=steps,
                rationale=(
                    f"{plan.rationale} | invalidated, looped back to "
                    f"{steps[loop_to].step_id}: {event.observation}"
                ),
            )

        if revised.rationale == prior_rationale:
            raise PlannerObligationError(
                MUST_REVISION_UPDATES_RATIONALE,
                obligation_id="CK-08.2",
            )
        return revised

    def next_step(self, plan: Plan) -> PlanStep | None:
        return next((s for s in plan.steps if s.status == "active"), None)

    @staticmethod
    def _topological(goals: list[Goal]) -> list[Goal]:
        by_id = {g.goal_id: g for g in goals}
        visited: dict[str, bool] = {}
        ordered: list[Goal] = []

        def visit(goal: Goal) -> None:
            state = visited.get(goal.goal_id)
            if state is True:
                return
            if state is False:
                raise ValueError(f"goal cycle detected at '{goal.goal_id}'")
            visited[goal.goal_id] = False
            for pre in goal.prerequisites:
                if pre in by_id:
                    visit(by_id[pre])
            visited[goal.goal_id] = True
            ordered.append(goal)

        for goal in goals:
            visit(goal)
        return ordered


def seed_goals_from_routing(*, concept_id: str, guidance_directive: str) -> list[Goal]:
    """First-turn / retarget seed: one goal derived from the routing directive."""
    concept = (concept_id or "").strip() or "unknown"
    desc = (guidance_directive or "").strip()[:GOAL_SEED_DESC_LIMIT] or f"Guide {concept}"
    return [
        Goal(
            goal_id=f"route.{concept}",
            description=desc,
            prerequisites=(),
            success_criterion=f"progress on concept '{concept}'",
        )
    ]


def format_plan_snapshot(plan: Plan) -> str:
    """Compact plan context for the model prompt — metadata only, no utterance."""
    nxt = next((s for s in plan.steps if s.status == "active"), None)
    steps = plan.steps[:PLAN_STEP_CONTEXT_LIMIT]
    step_bits = ";".join(f"{s.step_id}:{s.status}:{s.goal_id}" for s in steps)
    next_bit = f"{nxt.step_id}:{nxt.action}" if nxt else "none"
    rationale = plan.rationale[:GOAL_SEED_DESC_LIMIT]
    return (
        f"plan_id={plan.plan_id} next=[{next_bit}] "
        f"steps=[{step_bits}] rationale={rationale}"
    )


def plan_has_pending_steps(plan: Plan) -> bool:
    return any(s.status in ("pending", "active", "blocked") for s in plan.steps)


def assert_plan_bound_in_turn_context(
    *,
    plan: Plan | None,
    context: str | None = None,
    reply: str | None = None,
    obligation_id: str = PLANBIND_OBLIGATION_WIRE,
) -> None:
    """Conformance probe: plan snapshot MUST appear in turn context (prompt).

    ``reply`` is accepted as a deprecated alias for ``context`` (pre
    tests passed the directive stub; the model prompt is now the turn context).
    """
    if plan is None:
        raise PlannerObligationError(PLANBIND_MUST_WIRE, obligation_id=obligation_id)
    text = context if context is not None else reply
    if not isinstance(text, str):
        raise PlannerObligationError(PLANBIND_MUST_WIRE, obligation_id=obligation_id)
    marker = f"plan_id={plan.plan_id}"
    if marker not in text or "[plan]" not in text:
        raise PlannerObligationError(PLANBIND_MUST_WIRE, obligation_id=obligation_id)


def is_router_loop_back(*, mode: str, routing_rationale: str) -> bool:
    """True when TaskRouter remediates / loops to a weak prerequisite."""
    if (mode or "").strip() == ROUTER_LOOPBACK_MODE:
        return True
    return "looped back" in (routing_rationale or "")


def resolve_blocking_step_id(plan: Plan) -> str | None:
    """Active step, else pending, else already-blocked (idempotent re-revise)."""
    active = next((s for s in plan.steps if s.status == "active"), None)
    if active is not None:
        return active.step_id
    pending = next((s for s in plan.steps if s.status == "pending"), None)
    if pending is not None:
        return pending.step_id
    blocked = next((s for s in plan.steps if s.status == "blocked"), None)
    return blocked.step_id if blocked is not None else None


def assert_loopback_blocking_revision(
    *,
    prior: Plan,
    revised: Plan,
    mode: str,
    routing_rationale: str,
    persisted_mode: str | None,
    persisted_concept_id: str | None,
    expected_concept_id: str,
    obligation_id: str = PLANBIND_OBLIGATION_LOOPBACK,
) -> None:
    """Conformance probe: loop-back MUST blocking-revise and persist on state."""
    if not is_router_loop_back(mode=mode, routing_rationale=routing_rationale):
        raise PlannerObligationError(
            "assert_loopback_blocking_revision requires a loop-back routing signal",
            obligation_id=obligation_id,
        )
    if revised.rationale == prior.rationale:
        raise PlannerObligationError(
            MUST_REVISION_UPDATES_RATIONALE,
            obligation_id="CK-08.2",
        )
    if "| blocked " not in revised.rationale:
        raise PlannerObligationError(PLANBIND_MUST_LOOPBACK, obligation_id=obligation_id)
    if not any(s.status == "blocked" for s in revised.steps):
        raise PlannerObligationError(PLANBIND_MUST_LOOPBACK, obligation_id=obligation_id)
    if persisted_mode != ROUTER_LOOPBACK_MODE:
        raise PlannerObligationError(PLANBIND_MUST_LOOPBACK, obligation_id=obligation_id)
    if persisted_concept_id != expected_concept_id:
        raise PlannerObligationError(PLANBIND_MUST_LOOPBACK, obligation_id=obligation_id)


# ── : CK-08 conformance port (Python twin of ) ─────

PLANNING_OBLIGATION_IDS = {
    "cyclic_revise": "CK-08.1",
    "revision_updates_rationale": "CK-08.2",
}

PLANNING_STEP_SCAN_LIMIT = 64


class PlanningPort(Protocol):
    """Sync PlanningInterface surface used by the Python CK-08 port."""

    def compose(self, goals: list[Goal], context: str) -> Plan: ...
    def revise(self, plan: Plan, event: PlanRevisionEvent) -> Plan: ...
    def next_step(self, plan: Plan) -> PlanStep | None: ...


@dataclass(frozen=True)
class Ck08Verdict:
    obligation_id: str
    must_text: str
    passed: bool
    message: str = ""


@dataclass(frozen=True)
class Ck08Report:
    verdicts: tuple[Ck08Verdict, ...]

    @property
    def exit_code(self) -> int:
        return 0 if all(v.passed for v in self.verdicts) else 1

    @property
    def passed_count(self) -> int:
        return sum(1 for v in self.verdicts if v.passed)


def _subject_token(subject_id: str) -> str:
    tok = re.sub(r"[^A-Za-z0-9._-]", ".", subject_id)
    return re.sub(r"\.{2,}", ".", tok)


def build_ck08_probe_goals(subject_id: str) -> list[Goal]:
    """Subject-scoped metadata-only goals (never learner content)."""
    tok = _subject_token(subject_id)
    return [
        Goal(
            goal_id=f"probe.ck08.goal.foundation.{tok}",
            description=f"probe.ck08.foundation.{tok}",
            prerequisites=(),
            success_criterion=f"probe.ck08.foundation.ok.{tok}",
        ),
        Goal(
            goal_id=f"probe.ck08.goal.later.{tok}",
            description=f"probe.ck08.later.{tok}",
            prerequisites=(f"probe.ck08.goal.foundation.{tok}",),
            success_criterion=f"probe.ck08.later.ok.{tok}",
        ),
    ]


def build_ck08_probe_context(subject_id: str) -> str:
    return f"probe.ck08.context.{_subject_token(subject_id)}"


def detects_loop_back(
    before: Plan,
    revised: Plan,
    next_before: PlanStep | None,
    next_after: PlanStep | None,
) -> bool:
    """Port of contract-conformance `detectsLoopBack` (CK-08.1)."""
    before_steps = before.steps[:PLANNING_STEP_SCAN_LIMIT]
    after_steps = revised.steps[:PLANNING_STEP_SCAN_LIMIT]
    if not before_steps or not after_steps:
        return False

    index_by_id = {s.step_id: i for i, s in enumerate(before_steps)}

    for after in after_steps:
        prior = next((s for s in before_steps if s.step_id == after.step_id), None)
        if prior is None:
            continue
        idx = index_by_id.get(after.step_id, -1)
        if idx <= 0:
            continue
        earlier_before = before_steps[0]
        earlier_after = next(
            (s for s in after_steps if s.step_id == earlier_before.step_id), None
        )
        if earlier_after is None:
            continue
        later_regressed = prior.status in ("done", "active") and after.status in (
            "pending",
            "blocked",
            "abandoned",
        )
        earlier_reopened = earlier_before.status in ("done", "active") and (
            earlier_after.status in ("pending", "active")
        )
        if later_regressed and earlier_reopened:
            return True

    if next_before and next_after:
        i_before = index_by_id.get(next_before.step_id)
        i_after = index_by_id.get(next_after.step_id)
        if (
            i_before is not None
            and i_after is not None
            and i_after < i_before
        ):
            return True

    if next_after and before_steps[0].step_id == next_after.step_id:
        if next_before and next_before.step_id != next_after.step_id:
            return True
        if before_steps[0].status == "done" and next_after.status in (
            "pending",
            "active",
        ):
            return True

    return False


def _advance_for_loopback_probe(plan: Plan) -> Plan:
    steps = tuple(
        replace(
            s,
            status="done" if i == 0 else ("active" if i == 1 else s.status),
        )
        for i, s in enumerate(plan.steps[:PLANNING_STEP_SCAN_LIMIT])
    )
    return replace(plan, steps=steps)


def check_ck08_1_cyclic_revise(planning: PlanningPort, subject_id: str) -> Ck08Verdict:
    oid = PLANNING_OBLIGATION_IDS["cyclic_revise"]
    try:
        plan = planning.compose(
            build_ck08_probe_goals(subject_id),
            build_ck08_probe_context(subject_id),
        )
    except Exception as err:  # noqa: BLE001 — port surfaces as verdict
        return Ck08Verdict(
            obligation_id=oid,
            must_text=MUST_CYCLIC_REVISE,
            passed=False,
            message=f"compose() threw: {err}",
        )
    if len(plan.steps) < 2:
        return Ck08Verdict(
            obligation_id=oid,
            must_text=MUST_CYCLIC_REVISE,
            passed=False,
            message="compose() must return a plan with at least two steps for the probe",
        )
    advanced = _advance_for_loopback_probe(plan)
    later = advanced.steps[1]
    next_before = planning.next_step(advanced)
    try:
        revised = planning.revise(
            advanced,
            PlanRevisionEvent(
                observation=f"probe.ck08.failure.{_subject_token(subject_id)}",
                step_id=later.step_id,
                severity="invalidating",
            ),
        )
    except Exception as err:  # noqa: BLE001
        return Ck08Verdict(
            obligation_id=oid,
            must_text=MUST_CYCLIC_REVISE,
            passed=False,
            message=f"revise() threw on failure signal: {err}",
        )
    next_after = planning.next_step(revised)
    if not detects_loop_back(advanced, revised, next_before, next_after):
        return Ck08Verdict(
            obligation_id=oid,
            must_text=MUST_CYCLIC_REVISE,
            passed=False,
            message=(
                "revise() did not route back to an earlier node after an "
                "invalidating failure signal"
            ),
        )
    return Ck08Verdict(
        obligation_id=oid, must_text=MUST_CYCLIC_REVISE, passed=True
    )


def check_ck08_2_rationale_updates(planning: PlanningPort, subject_id: str) -> Ck08Verdict:
    oid = PLANNING_OBLIGATION_IDS["revision_updates_rationale"]
    try:
        plan = planning.compose(
            build_ck08_probe_goals(subject_id),
            build_ck08_probe_context(subject_id),
        )
    except Exception as err:  # noqa: BLE001
        return Ck08Verdict(
            obligation_id=oid,
            must_text=MUST_REVISION_UPDATES_RATIONALE,
            passed=False,
            message=f"compose() threw: {err}",
        )
    if not plan.rationale:
        return Ck08Verdict(
            obligation_id=oid,
            must_text=MUST_REVISION_UPDATES_RATIONALE,
            passed=False,
            message="compose() must supply a non-empty rationale",
        )
    prior = plan.rationale
    step_id = plan.steps[0].step_id if plan.steps else None
    try:
        revised = planning.revise(
            plan,
            PlanRevisionEvent(
                observation=f"probe.ck08.rationale.{_subject_token(subject_id)}",
                step_id=step_id,
                severity="blocking",
            ),
        )
    except Exception as err:  # noqa: BLE001
        return Ck08Verdict(
            obligation_id=oid,
            must_text=MUST_REVISION_UPDATES_RATIONALE,
            passed=False,
            message=f"revise() threw: {err}",
        )
    if not revised.rationale or revised.rationale == prior:
        return Ck08Verdict(
            obligation_id=oid,
            must_text=MUST_REVISION_UPDATES_RATIONALE,
            passed=False,
            message="revise() left rationale unchanged (silent plan mutation)",
        )
    return Ck08Verdict(
        obligation_id=oid,
        must_text=MUST_REVISION_UPDATES_RATIONALE,
        passed=True,
    )


def run_ck08_conformance(
    planning: PlanningPort,
    *,
    subject_id: str,
    emit: Callable[[dict[str, object]], None] | None = None,
) -> Ck08Report:
    """Run CK-08.1 + CK-08.2 against a PlanningPort (GraphPlanner reference)."""
    if not subject_id or not subject_id.strip():
        raise PlannerObligationError(
            "run_ck08_conformance requires subjectId (subject isolation)",
            obligation_id="CK-08",
        )
    sid = subject_id.strip()
    v1 = check_ck08_1_cyclic_revise(planning, sid)
    v2 = check_ck08_2_rationale_updates(planning, sid)
    for v in (v1, v2):
        emit and emit(
            {
                "event": "conformance.ck08",
                "subjectId": sid,
                "obligationId": v.obligation_id,
                "outcome": "pass" if v.passed else "fail",
                # Never include raw learner content — probe metadata only.
            }
        )
        logger.info(
            "ck08_conformance subject_id=%s obligation=%s outcome=%s",
            sid,
            v.obligation_id,
            "pass" if v.passed else "fail",
        )
    return Ck08Report(verdicts=(v1, v2))


class SilentRationalePlanner(GraphPlanner):
    """Violation fixture: revise does not rewrite rationale (fails CK-08.2)."""

    def revise(self, plan: Plan, event: PlanRevisionEvent) -> Plan:
        return plan


class NoLoopBackPlanner(GraphPlanner):
    """Violation fixture: invalidating revise is a no-op (fails CK-08.1)."""

    def revise(self, plan: Plan, event: PlanRevisionEvent) -> Plan:
        if event.severity == "invalidating":
            # Touch rationale so CK-08.2 alone would pass, but no loop-back.
            return replace(
                plan,
                rationale=f"{plan.rationale} | noted: {event.observation}",
            )
        return super().revise(plan, event)
