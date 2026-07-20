"""Pydantic mirrors of the wire contract.

The canonical contract lives in ``packages/sync-protocol/src/contract.ts``.
These models MUST stay field-for-field identical to the TypeScript source;
CI drift checks compare the generated JSON Schemas of both sides.

Parity audit fixes applied
  1. SyncRequest.syncAttemptId — min_length=8 → UUID pattern (Zod ``.uuid()``)
  2. ConceptMastery.alpha/beta values — add ``ge=0`` (Zod ``nonnegative()``)
  3. CognitiveState.deviceIds items — ``min_length=1`` (Zod ``string().min(1)``)
  4. CognitiveState.activeConceptId — nonempty string when not null
  5. stateVector / lastKnownCloudVector / compactedSampleTimestamps — HLC regex
     (plain strings, never ``format: date-time``)
  6. AgentTurnResponse.nextConceptId — ``min_length=1``
  7. protocolVersion — required (no default) so requiredness matches Zod literals

All timestamps are Hybrid Logical Clock strings of the form
``"<physical:15d>:<logical:6d>:<deviceId>"`` whose lexicographic order is
the total order used by every CRDT register.
"""

from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    RootModel,
    StringConstraints,
    ValidationError,
    model_validator,
)
from pydantic.json_schema import SkipJsonSchema

HLC_PATTERN = re.compile(r"^\d{15}:\d{6}:[A-Za-z0-9_-]{4,64}$")
# Aligns with Zod ``z.string().uuid()`` (RFC 4122 hex form).
UUID_PATTERN = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)

NonEmptyStr = Annotated[str, StringConstraints(min_length=1)]
NonNegFloat = Annotated[float, Field(ge=0)]
NonNegInt = Annotated[int, Field(ge=0)]
# Patterns surface in model_json_schema — field_validators alone do not.
HlcStr = Annotated[str, StringConstraints(pattern=HLC_PATTERN.pattern)]
UuidStr = Annotated[str, StringConstraints(pattern=UUID_PATTERN.pattern)]

GuidanceMode = Literal[
    "exploratory",
    "guided",
    "reinforcement",
    "prerequisite-remediation",
    "diagnostic",
]

Outcome = Literal["correct", "partial", "incorrect", "ungraded"]

ProtocolVersionLiteral = Literal["1.0.0"]


class FrictionSample(BaseModel):
    """Instantaneous cognitive-friction measurement (the unit of evidence)."""

    conceptId: NonEmptyStr
    hesitationMs: NonNegInt
    inputVelocity: NonNegFloat
    revisionCount: NonNegInt
    assistanceRequested: bool
    outcome: Outcome
    capturedAt: HlcStr


class ConceptMastery(BaseModel):
    """Beta-posterior mastery pseudo-counts, sharded per device (G-Counters)."""

    conceptId: NonEmptyStr
    alpha: dict[str, NonNegFloat]
    beta: dict[str, NonNegFloat]
    lastExercisedAt: HlcStr

    @property
    def mastery_mean(self) -> float:
        """Posterior mean of the Beta distribution with a weak (1,1) prior."""
        a = sum(self.alpha.values()) + 1.0
        b = sum(self.beta.values()) + 1.0
        return a / (a + b)


class SubjectProfile(BaseModel):
    ageBand: Literal["child", "adolescent", "adult"]
    track: NonEmptyStr
    language: Annotated[str, StringConstraints(min_length=2)]
    updatedAt: HlcStr


class CognitiveState(BaseModel):
    """THE canonical subject document — identical shape on edge, wire, cloud."""

    # Required — mirrors Zod ``z.literal(PROTOCOL_VERSION)`` (no default filler).
    protocolVersion: ProtocolVersionLiteral
    subjectId: NonEmptyStr
    deviceIds: list[NonEmptyStr]
    # Required + nullable (not optional/missing) — mirrors ``.nullable()``.
    activeConceptId: NonEmptyStr | None
    mode: GuidanceMode
    mastery: dict[str, ConceptMastery]
    frictionLog: list[FrictionSample]
    profile: SubjectProfile
    stateVector: dict[str, HlcStr]


class SyncAdvisory(BaseModel):
    code: Literal[
        "CLOCK_SKEW_CLAMPED",
        "DUPLICATE_SAMPLE_DROPPED",
        "UNKNOWN_CONCEPT_QUARANTINED",
        "STATE_VECTOR_REGRESSION",
        "DEPRECATED_FIELD_PRESENT",
    ]
    detail: str


class SyncWireHeaders(BaseModel):
    """W3C Trace Context carrier on SyncRequest. Metadata only."""

    model_config = ConfigDict(extra="forbid")

    # Optional (omit OK) but not nullable — mirrors Zod ``.optional()``.
    traceparent: (
        Annotated[str, StringConstraints(min_length=1, max_length=128)]
        | SkipJsonSchema[None]
    ) = None
    tracestate: Annotated[str, StringConstraints(max_length=512)] | SkipJsonSchema[None] = (
        None
    )

    @model_validator(mode="before")
    @classmethod
    def headers_optional_not_nullable(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key in ("traceparent", "tracestate"):
                if key in data and data[key] is None:
                    raise ValueError(f"{key} is optional but not nullable")
        return data


class SyncRequest(BaseModel):
    protocolVersion: ProtocolVersionLiteral
    deviceId: Annotated[str, StringConstraints(min_length=4)]
    edgeState: CognitiveState
    lastKnownCloudVector: dict[str, HlcStr]
    syncAttemptId: UuidStr
    # Optional (omit OK) but not nullable — mirrors Zod ``.optional()``.
    headers: SyncWireHeaders | SkipJsonSchema[None] = None

    @model_validator(mode="before")
    @classmethod
    def headers_optional_not_nullable(cls, data: Any) -> Any:
        if isinstance(data, dict) and "headers" in data and data["headers"] is None:
            raise ValueError("headers is optional but not nullable")
        return data

    def model_dump(self, *, mode: str = "python", **kwargs: Any) -> Any:
        # Zod `.optional()` omits absent keys on the wire — never emit JSON null.
        if mode == "json" and "exclude_none" not in kwargs:
            kwargs["exclude_none"] = True
        return super().model_dump(mode=mode, **kwargs)


class SyncResponse(BaseModel):
    protocolVersion: ProtocolVersionLiteral
    mergedState: CognitiveState
    compactedSampleTimestamps: list[HlcStr]
    advisories: list[SyncAdvisory]


class AgentTurnRequest(BaseModel):
    protocolVersion: ProtocolVersionLiteral
    subjectId: NonEmptyStr
    sessionId: NonEmptyStr
    utterance: str
    friction: FrictionSample


class FreshnessMarker(BaseModel):
    """Stale / degraded read marker — last-known-good, never fabricated."""

    capturedAt: Annotated[str, StringConstraints(min_length=1, max_length=128)]
    source: Literal["last-known-good", "local-cache"]


class AgentTurnResponse(BaseModel):
    protocolVersion: ProtocolVersionLiteral
    reply: str
    nextConceptId: NonEmptyStr
    mode: GuidanceMode
    routingRationale: str
    masteryEstimate: Annotated[float, Field(ge=0, le=1)]
    # Optional (omit OK) but not nullable — mirrors Zod ``.optional()``.
    # Present when the model provider timed out (ATR-05 degraded reply).
    degraded: bool | SkipJsonSchema[None] = None
    freshnessMarker: FreshnessMarker | SkipJsonSchema[None] = None

    @model_validator(mode="before")
    @classmethod
    def optional_fields_not_nullable(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key in ("degraded", "freshnessMarker"):
                if key in data and data[key] is None:
                    raise ValueError(f"{key} is optional but not nullable")
        return data


# ── Tool-call envelope (P6; mirrors tool_envelope.ts) ────────────────────────

TOOL_CALL_ENVELOPE_MAX_CALLS = 16

ToolEnvelopeErrorCode = Literal[
    "INVALID_JSON",
    "MISSING_FENCE",
    "MISSING_TOOL_NAME",
    "INVALID_ARGUMENTS",
    "INVALID_CALL_ID",
    "EMPTY_ENVELOPE",
    "TOO_MANY_CALLS",
    "AMBIGUOUS_ARRAY",
    "SCHEMA_VIOLATION",
    "SUBJECT_REQUIRED",
]

TOOL_ENVELOPE_ERROR_CODES: tuple[ToolEnvelopeErrorCode, ...] = (
    "INVALID_JSON",
    "MISSING_FENCE",
    "MISSING_TOOL_NAME",
    "INVALID_ARGUMENTS",
    "INVALID_CALL_ID",
    "EMPTY_ENVELOPE",
    "TOO_MANY_CALLS",
    "AMBIGUOUS_ARRAY",
    "SCHEMA_VIOLATION",
    "SUBJECT_REQUIRED",
)

_TOOL_ENVELOPE_MESSAGES: dict[ToolEnvelopeErrorCode, str] = {
    "INVALID_JSON": "tool-call fence body is not valid JSON",
    "MISSING_FENCE": "tool-call finishReason without a fenced envelope",
    "MISSING_TOOL_NAME": "each tool call requires a non-empty toolName string",
    "INVALID_ARGUMENTS": "arguments must be a JSON object",
    "INVALID_CALL_ID": "callId is optional but must be a non-empty string when set",
    "EMPTY_ENVELOPE": "tool-call envelope must contain at least one call",
    "TOO_MANY_CALLS": f"tool-call envelope exceeds max of {TOOL_CALL_ENVELOPE_MAX_CALLS} calls",
    "AMBIGUOUS_ARRAY": "array envelope elements must each be a tool-call object",
    "SCHEMA_VIOLATION": "tool-call envelope failed schema validation",
    "SUBJECT_REQUIRED": "tool-call envelope parse requires a subjectId scope",
}


class ToolCall(BaseModel):
    """One fenced tool-call entry — unknown keys stripped (``extra='ignore'``)."""

    model_config = ConfigDict(extra="ignore")

    toolName: NonEmptyStr
    arguments: dict[str, Any]
    # Optional (omit OK) but not nullable — mirrors Zod ``.optional()``.
    callId: Annotated[str, StringConstraints(min_length=1, max_length=128)] | None = (
        None
    )

    @model_validator(mode="before")
    @classmethod
    def call_id_optional_not_nullable(cls, data: Any) -> Any:
        if isinstance(data, dict) and "callId" in data and data["callId"] is None:
            raise ValueError("callId is optional but not nullable")
        return data


class ToolCallEnvelope(
    RootModel[
        ToolCall
        | Annotated[
            list[ToolCall],
            Field(min_length=1, max_length=TOOL_CALL_ENVELOPE_MAX_CALLS),
        ]
    ]
):
    """Single tool-call object or bounded non-empty array."""


class ToolEnvelopeError(BaseModel):
    """Structured correction-loop payload — never stack traces or arg bodies."""

    model_config = ConfigDict(extra="forbid")

    code: ToolEnvelopeErrorCode
    message: Annotated[str, StringConstraints(min_length=1, max_length=256)]
    issuePath: NonEmptyStr
    callIndex: NonNegInt | None = None


def make_tool_envelope_error(
    code: ToolEnvelopeErrorCode,
    *,
    issue_path: str = "(root)",
    call_index: int | None = None,
) -> ToolEnvelopeError:
    payload: dict[str, Any] = {
        "code": code,
        "message": _TOOL_ENVELOPE_MESSAGES[code],
        "issuePath": issue_path,
    }
    if call_index is not None:
        payload["callIndex"] = call_index
    return ToolEnvelopeError.model_validate(payload)


def classify_tool_envelope_value(input_data: Any) -> ToolEnvelopeError | None:
    """Map a parsed JSON value to a closed repair-loop code (or None if valid)."""
    if isinstance(input_data, list):
        if len(input_data) == 0:
            return make_tool_envelope_error("EMPTY_ENVELOPE")
        if len(input_data) > TOOL_CALL_ENVELOPE_MAX_CALLS:
            return make_tool_envelope_error("TOO_MANY_CALLS")
        for i, item in enumerate(input_data):
            if not isinstance(item, dict):
                return make_tool_envelope_error(
                    "AMBIGUOUS_ARRAY",
                    issue_path=str(i),
                    call_index=i,
                )

    try:
        ToolCallEnvelope.model_validate(input_data)
        return None
    except ValidationError as err:
        locs = [str(p) for e in err.errors() for p in (e.get("loc") or ())]
        msg = " ".join(str(e.get("msg", "")) for e in err.errors()).lower()
        if "callid" in "".join(locs).lower() or "nullable" in msg:
            return make_tool_envelope_error("INVALID_CALL_ID", issue_path="callId")
        if "toolname" in "".join(locs).lower():
            return make_tool_envelope_error("MISSING_TOOL_NAME", issue_path="toolName")
        if "arguments" in locs or "arguments" in "".join(locs).lower():
            return make_tool_envelope_error(
                "INVALID_ARGUMENTS",
                issue_path="arguments",
            )
        return make_tool_envelope_error(
            "SCHEMA_VIOLATION",
            issue_path=locs[0] if locs else "(root)",
        )


def parse_tool_call_envelope_json(
    json_text: str,
) -> dict[str, Any]:
    """Parse a fence-body string; returns ``{ok, envelope|error}`` (no stacks)."""
    try:
        value = json.loads(json_text)
    except json.JSONDecodeError:
        return {"ok": False, "error": make_tool_envelope_error("INVALID_JSON")}
    classified = classify_tool_envelope_value(value)
    if classified is not None:
        return {"ok": False, "error": classified}
    env = ToolCallEnvelope.model_validate(value)
    root = env.root
    calls = root if isinstance(root, list) else [root]
    return {"ok": True, "envelope": calls}


def parse_tool_call_envelope(
    input_data: Any,
    *,
    subject_id: str,
    device_id: str | None = None,
) -> dict[str, Any]:
    """Subject-scoped envelope parse — metadata outcomes only."""
    if not isinstance(subject_id, str) or len(subject_id) == 0:
        error = make_tool_envelope_error("SUBJECT_REQUIRED", issue_path="subjectId")
        out: dict[str, Any] = {
            "outcome": "rejected",
            "subjectId": None,
            "errorCode": error.code,
            "error": error,
        }
        if device_id is not None:
            out["deviceId"] = device_id
        return out

    classified = classify_tool_envelope_value(input_data)
    if classified is not None:
        rejected: dict[str, Any] = {
            "outcome": "rejected",
            "subjectId": subject_id,
            "errorCode": classified.code,
            "error": classified,
        }
        if device_id is not None:
            rejected["deviceId"] = device_id
        return rejected

    env = ToolCallEnvelope.model_validate(input_data)
    root = env.root
    calls = root if isinstance(root, list) else [root]
    accepted: dict[str, Any] = {
        "outcome": "accepted",
        "subjectId": subject_id,
        "callCount": len(calls),
        "toolNames": [c.toolName for c in calls],
        "envelope": calls,
    }
    if device_id is not None:
        accepted["deviceId"] = device_id
    return accepted


# ── Harness stream frames (P6 wire surface; mirrors harness_frames.ts) ───────

MeterLocality = Literal["on-device", "self-hosted", "external-api"]
ToolStatusState = Literal["pending", "running", "success", "error"]
HarnessFrameType = Literal[
    "SESSION_START",
    "THOUGHT_DELTA",
    "ANSWER_DELTA",
    "TOOL_STATUS",
    "ADVISORY_ATTACH",
    "METER_TICK",
    "TURN_COMPLETE",
    "HARNESS_ERROR",
]

HARNESS_FRAME_TYPES: tuple[HarnessFrameType, ...] = (
    "SESSION_START",
    "THOUGHT_DELTA",
    "ANSWER_DELTA",
    "TOOL_STATUS",
    "ADVISORY_ATTACH",
    "METER_TICK",
    "TURN_COMPLETE",
    "HARNESS_ERROR",
)


class MeterEvent(BaseModel):
    """Per-turn metering snapshot (METER_TICK.tick / wire MeterEvent.json).

    Twin of sync-protocol ``metering.ts``. Cached and fresh input tokens are
    separate fields. Metadata only — never prompt or completion text.
    """

    model_config = ConfigDict(extra="forbid")

    inputTokens: NonNegInt
    outputTokens: NonNegInt
    cachedInputTokens: NonNegInt
    latencyMs: NonNegInt
    modelId: NonEmptyStr
    locality: MeterLocality
    aborted: bool


MeterEventFailureClass = Literal[
    "missing_subject",
    "unrecognized_keys",
    "schema_violation",
    "content_leak",
]

_METER_CONTENT_LEAK_KEYS = frozenset(
    {"prompt", "completion", "text", "delta", "utterance", "arguments"}
)


def parse_meter_event(
    input_data: Any,
    *,
    subject_id: str,
    device_id: str | None = None,
) -> dict[str, Any]:
    """Parse MeterEvent at the trust boundary (subject-scoped outcome)."""
    if not isinstance(subject_id, str) or len(subject_id) == 0:
        out: dict[str, Any] = {
            "outcome": "rejected",
            "subjectId": None,
            "failureClass": "missing_subject",
            "issuePath": "subjectId",
        }
        if device_id is not None:
            out["deviceId"] = device_id
        return out

    try:
        event = MeterEvent.model_validate(input_data)
    except ValidationError as exc:
        failure: MeterEventFailureClass = "schema_violation"
        issue_path = "(root)"
        if isinstance(input_data, dict) and _METER_CONTENT_LEAK_KEYS.intersection(
            input_data.keys()
        ):
            failure = "content_leak"
        errs = exc.errors()
        if errs:
            loc = errs[0].get("loc") or ()
            issue_path = ".".join(str(p) for p in loc) if loc else "(root)"
            if errs[0].get("type") == "extra_forbidden":
                failure = (
                    "content_leak"
                    if failure == "content_leak"
                    else "unrecognized_keys"
                )
        out = {
            "outcome": "rejected",
            "subjectId": subject_id,
            "failureClass": failure,
            "issuePath": issue_path,
        }
        if device_id is not None:
            out["deviceId"] = device_id
        return out

    accepted: dict[str, Any] = {
        "outcome": "accepted",
        "subjectId": subject_id,
        "event": event,
        "aborted": event.aborted,
    }
    if device_id is not None:
        accepted["deviceId"] = device_id
    return accepted


class _HarnessFrameBase(BaseModel):
    """Commons every harness frame carries — subject-scoped sequence stream."""

    model_config = ConfigDict(extra="forbid")

    sequenceIndex: NonNegInt
    correlationId: NonEmptyStr
    subjectId: NonEmptyStr


class SessionStartFrame(_HarnessFrameBase):
    type: Literal["SESSION_START"]
    protocolVersion: NonEmptyStr
    pinnedAt: NonEmptyStr


class ThoughtDeltaFrame(_HarnessFrameBase):
    type: Literal["THOUGHT_DELTA"]
    delta: str


class AnswerDeltaFrame(_HarnessFrameBase):
    type: Literal["ANSWER_DELTA"]
    delta: str


class ToolStatusFrame(_HarnessFrameBase):
    type: Literal["TOOL_STATUS"]
    toolCallId: NonEmptyStr
    status: ToolStatusState
    # Optional (omit OK) but not nullable — mirrors Zod ``z.string().optional()``.
    detail: str | None = None

    @model_validator(mode="before")
    @classmethod
    def detail_optional_not_nullable(cls, data: Any) -> Any:
        if isinstance(data, dict) and "detail" in data and data["detail"] is None:
            raise ValueError("TOOL_STATUS.detail is optional but not nullable")
        return data


class AdvisoryAttachFrame(_HarnessFrameBase):
    type: Literal["ADVISORY_ATTACH"]
    advisory: SyncAdvisory


class MeterTickFrame(_HarnessFrameBase):
    type: Literal["METER_TICK"]
    tick: MeterEvent


class TurnCompleteFrame(_HarnessFrameBase):
    type: Literal["TURN_COMPLETE"]
    turnId: NonEmptyStr


class HarnessErrorFrame(_HarnessFrameBase):
    type: Literal["HARNESS_ERROR"]
    code: NonEmptyStr
    message: NonEmptyStr
    recoverable: bool


HarnessFrameVariant = Annotated[
    SessionStartFrame
    | ThoughtDeltaFrame
    | AnswerDeltaFrame
    | ToolStatusFrame
    | AdvisoryAttachFrame
    | MeterTickFrame
    | TurnCompleteFrame
    | HarnessErrorFrame,
    Field(discriminator="type"),
]


class HarnessFrame(RootModel[HarnessFrameVariant]):
    """Discriminated union of harness stream frames — parse, never cast."""


HarnessFrameFailureClass = Literal[
    "unknown_type",
    "missing_subject",
    "invalid_sequence",
    "optional_nullable_mismatch",
    "unrecognized_keys",
    "schema_violation",
]


def _classify_harness_frame_failure(
    err: ValidationError,
) -> tuple[HarnessFrameFailureClass, str]:
    errors = err.errors()
    if not errors:
        return "schema_violation", "(root)"
    first = errors[0]
    loc = first.get("loc") or ()
    issue_path = ".".join(str(p) for p in loc) if loc else "(root)"
    err_type = str(first.get("type", ""))
    msg = str(first.get("msg", ""))
    # Discriminated unions may prefix loc with the variant tag
    # (e.g. ``("THOUGHT_DELTA", "subjectId")``).
    field_names = {p for p in loc if isinstance(p, str)}

    if err_type == "extra_forbidden" or "extra" in err_type:
        return "unrecognized_keys", issue_path
    if err_type in {
        "union_tag_invalid",
        "union_tag_not_found",
        "literal_error",
    } or ("type" in field_names and err_type == "enum"):
        return "unknown_type", "type"
    if "subjectId" in field_names:
        return "missing_subject", "subjectId"
    if "sequenceIndex" in field_names:
        return "invalid_sequence", "sequenceIndex"
    if "detail" in field_names and (
        "nullable" in msg.lower() or err_type in {"value_error", "string_type"}
    ):
        return "optional_nullable_mismatch", issue_path
    return "schema_violation", issue_path


def parse_harness_frame(
    input_data: Any,
    *,
    device_id: str | None = None,
) -> dict[str, Any]:
    """Validate a wire frame; return telemetry-safe outcome (never raw deltas)."""
    peek_subject: str | None = None
    if isinstance(input_data, dict):
        raw_subject = input_data.get("subjectId")
        if isinstance(raw_subject, str) and len(raw_subject) > 0:
            peek_subject = raw_subject

    try:
        frame = HarnessFrame.model_validate(input_data)
    except ValidationError as err:
        failure_class, issue_path = _classify_harness_frame_failure(err)
        out: dict[str, Any] = {
            "outcome": "rejected",
            "subjectId": peek_subject,
            "failureClass": failure_class,
            "issuePath": issue_path,
        }
        if device_id is not None:
            out["deviceId"] = device_id
        return out

    body = frame.root
    accepted: dict[str, Any] = {
        "outcome": "accepted",
        "subjectId": body.subjectId,
        "type": body.type,
        "sequenceIndex": body.sequenceIndex,
        "frame": body,
    }
    if device_id is not None:
        accepted["deviceId"] = device_id
    return accepted


def assert_monotonic_sequence(
    frames: list[Any],
) -> dict[str, Any]:
    """Contiguous sequenceIndex within a session; gaps are never silent."""
    if not frames:
        return {"ok": True}
    expected = int(frames[0].sequenceIndex)
    subject_id = str(frames[0].subjectId)
    for frame in frames:
        actual = int(frame.sequenceIndex)
        if actual != expected:
            return {
                "ok": False,
                "code": "SEQUENCE_GAP",
                "subjectId": str(getattr(frame, "subjectId", None) or subject_id),
                "expected": expected,
                "actual": actual,
            }
        expected += 1
    return {"ok": True}


# ── Sync audit query (SYNC-06 operator read surface) ─────────────────────────

AdvisoryCode = Literal[
    "CLOCK_SKEW_CLAMPED",
    "DUPLICATE_SAMPLE_DROPPED",
    "UNKNOWN_CONCEPT_QUARANTINED",
    "STATE_VECTOR_REGRESSION",
    "DEPRECATED_FIELD_PRESENT",
]


class SyncAuditListQuery(BaseModel):
    """Query params for GET /v1/subjects/{id}/sync-audit.

    ``extra='forbid'`` so unknown filters are 422, never silently ignored.
    """

    model_config = ConfigDict(extra="forbid")

    limit: int = Field(default=50, ge=1, le=100)
    cursor: str | None = None
    advisory_code: AdvisoryCode | None = None


class SyncAuditItem(BaseModel):
    """One sync_audit row on the wire (no raw learner content)."""

    subjectId: NonEmptyStr
    deviceId: Annotated[str, StringConstraints(min_length=4)]
    syncAttemptId: UuidStr
    protocolVersion: ProtocolVersionLiteral
    advisories: list[SyncAdvisory]
    stateVectorBefore: dict[str, HlcStr]
    stateVectorAfter: dict[str, HlcStr]
    createdAt: datetime


class SyncAuditPage(BaseModel):
    """Keyset-paginated newest-first audit page for one subject."""

    subjectId: NonEmptyStr
    items: list[SyncAuditItem]
    # Null / omitted = last page; empty string is invalid (not a cursor).
    nextCursor: Annotated[str, StringConstraints(min_length=1)] | None = None


# Re-export surface for consumers and parity tests.
__all__ = [
    "HLC_PATTERN",
    "UUID_PATTERN",
    "GuidanceMode",
    "Outcome",
    "FrictionSample",
    "ConceptMastery",
    "SubjectProfile",
    "CognitiveState",
    "SyncAdvisory",
    "SyncWireHeaders",
    "SyncRequest",
    "SyncResponse",
    "AgentTurnRequest",
    "AgentTurnResponse",
    "FreshnessMarker",
    "TOOL_CALL_ENVELOPE_MAX_CALLS",
    "ToolEnvelopeErrorCode",
    "TOOL_ENVELOPE_ERROR_CODES",
    "ToolCall",
    "ToolCallEnvelope",
    "ToolEnvelopeError",
    "make_tool_envelope_error",
    "classify_tool_envelope_value",
    "parse_tool_call_envelope_json",
    "parse_tool_call_envelope",
    "MeterLocality",
    "ToolStatusState",
    "HarnessFrameType",
    "HARNESS_FRAME_TYPES",
    "MeterEvent",
    "MeterEventFailureClass",
    "parse_meter_event",
    "SessionStartFrame",
    "ThoughtDeltaFrame",
    "AnswerDeltaFrame",
    "ToolStatusFrame",
    "AdvisoryAttachFrame",
    "MeterTickFrame",
    "TurnCompleteFrame",
    "HarnessErrorFrame",
    "HarnessFrameVariant",
    "HarnessFrame",
    "HarnessFrameFailureClass",
    "parse_harness_frame",
    "assert_monotonic_sequence",
    "AdvisoryCode",
    "SyncAuditListQuery",
    "SyncAuditItem",
    "SyncAuditPage",
]
