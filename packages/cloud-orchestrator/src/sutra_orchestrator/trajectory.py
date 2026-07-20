"""Pydantic mirror of TurnTrajectoryV1 (metadata-grade capture wire schema).

Canonical Zod lives in ``@moolam/sync-protocol`` ``turnTrajectoryV1Schema``.
Raw keystrokes and prompt/tool argument bodies are forbidden — ``extra="forbid"``.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

HLC_PATTERN = r"^\d{15}:\d{6}:[A-Za-z0-9_-]{4,64}$"
MAX_ID = 128
MAX_HASH = 128
MAX_MODEL_ID = 256
MAX_STAGES = 32
MAX_TOOL_CALLS = 64

BoundedId = Annotated[str, StringConstraints(min_length=1, max_length=MAX_ID)]
HashStr = Annotated[str, StringConstraints(min_length=1, max_length=MAX_HASH)]
ModelId = Annotated[str, StringConstraints(min_length=1, max_length=MAX_MODEL_ID)]
HlcStr = Annotated[str, StringConstraints(pattern=HLC_PATTERN)]
OpCode = Annotated[str, StringConstraints(min_length=1, max_length=64)]


class TrajectoryFormatStageRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")

    stage: Literal["perceive", "reason", "act"]
    status: Literal["ok", "aborted", "error", "skipped"]
    chunkIndex: int | None = Field(default=None, ge=0, le=MAX_STAGES)
    opCode: OpCode | None = None
    startedAt: HlcStr | None = None
    endedAt: HlcStr | None = None


class TrajectoryToolCallRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")

    callId: BoundedId
    toolName: BoundedId
    argsHash: HashStr
    argsByteLength: int | None = Field(default=None, ge=0)
    status: Literal["ok", "error", "aborted", "denied"]
    resultHash: HashStr | None = None
    resultByteLength: int | None = Field(default=None, ge=0)


class TrajectoryOutcomes(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal["completed", "aborted", "error", "partial"]
    terminalStage: Literal["perceive", "reason", "act"] | None = None


class TurnTrajectoryV1(BaseModel):
    """Metadata-grade turn trajectory — hashes and structured stages only."""

    model_config = ConfigDict(extra="forbid")

    trajectoryFormatVersion: Literal["trajectory.v1"]
    turnId: BoundedId
    subjectId: BoundedId
    deviceId: BoundedId
    sessionId: BoundedId | None = None
    capturedAt: HlcStr
    locality: Literal["on-device", "self-hosted"]
    consentRecordId: BoundedId
    stages: list[TrajectoryFormatStageRecord] = Field(max_length=MAX_STAGES)
    toolCalls: list[TrajectoryToolCallRecord] = Field(max_length=MAX_TOOL_CALLS)
    outcomes: TrajectoryOutcomes
    modelId: ModelId
    promptHash: HashStr
    responseHash: HashStr
    promptByteLength: int | None = Field(default=None, ge=0)
    responseByteLength: int | None = Field(default=None, ge=0)
