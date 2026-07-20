"""Consent-attached aggregation batch ingest.

Thin FastAPI transport: strict Pydantic parse -> subject-scoped repository ->
typed response. Authentication is inherited from the parent protected router;
scope specialization is wired separately.
"""

from __future__ import annotations

import json
import logging
import threading
from typing import Annotated, Literal, Protocol, runtime_checkable

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    model_validator,
)

from ..auth import (
    AGGREGATION_INGEST_OPERATION_SCOPE,
    CallerContext,
    enforce_operation_scope,
    enforce_subject_scope,
    get_caller_context,
)

HLC_PATTERN = r"^\d{15}:\d{6}:[A-Za-z0-9_-]{4,64}$"
MAX_BATCH_ROLLUPS = 100
MAX_BATCH_BYTES = 1_048_576
MAX_CONCEPTS_PER_ROLLUP = 512
MAX_SAMPLES_PER_ROLLUP = 4096

BoundedId = Annotated[str, StringConstraints(min_length=1, max_length=128)]
HlcStr = Annotated[str, StringConstraints(pattern=HLC_PATTERN)]

logger = logging.getLogger("sutra.orchestrator.aggregation")
router = APIRouter()


class OutcomeCounts(BaseModel):
    model_config = ConfigDict(extra="forbid")

    correct: int = Field(ge=0)
    partial: int = Field(ge=0)
    incorrect: int = Field(ge=0)
    ungraded: int = Field(ge=0)


class ConceptFrictionRollup(BaseModel):
    model_config = ConfigDict(extra="forbid")

    conceptId: BoundedId
    sampleCount: int = Field(ge=0, le=MAX_SAMPLES_PER_ROLLUP)
    hesitationMsSum: int = Field(ge=0)
    hesitationMsMax: int = Field(ge=0)
    inputVelocitySum: float = Field(ge=0)
    revisionCountSum: int = Field(ge=0)
    assistanceRequestedCount: int = Field(ge=0)
    outcomes: OutcomeCounts

    @model_validator(mode="after")
    def validate_counts(self) -> ConceptFrictionRollup:
        outcome_count = (
            self.outcomes.correct
            + self.outcomes.partial
            + self.outcomes.incorrect
            + self.outcomes.ungraded
        )
        if outcome_count != self.sampleCount:
            raise ValueError(
                "aggregation.concept.outcome_count: outcomes must sum to sampleCount"
            )
        if self.assistanceRequestedCount > self.sampleCount:
            raise ValueError(
                "aggregation.concept.assistance_count: assistance count exceeds sampleCount"
            )
        return self


class FrictionAggregationRollup(BaseModel):
    """Pydantic mirror of the aggregation.v1 TypeScript wire schema."""

    model_config = ConfigDict(extra="forbid")

    schemaVersion: Literal["aggregation.v1"]
    subjectId: BoundedId
    deviceId: BoundedId
    consentRecordId: BoundedId
    locality: Literal["on-device", "self-hosted"]
    rolledUpAt: HlcStr
    sampleCount: int = Field(ge=0, le=MAX_SAMPLES_PER_ROLLUP)
    concepts: list[ConceptFrictionRollup] = Field(
        max_length=MAX_CONCEPTS_PER_ROLLUP
    )

    @model_validator(mode="after")
    def validate_sample_count(self) -> FrictionAggregationRollup:
        if sum(item.sampleCount for item in self.concepts) != self.sampleCount:
            raise ValueError(
                "aggregation.rollup.sample_count: concept counts must sum to sampleCount"
            )
        return self


class AggregationBatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    batchId: BoundedId
    subjectId: BoundedId
    deviceId: BoundedId
    rollups: list[FrictionAggregationRollup]

    @model_validator(mode="after")
    def validate_subject_scope(self) -> AggregationBatchRequest:
        for index, rollup in enumerate(self.rollups):
            if rollup.subjectId != self.subjectId:
                raise ValueError(
                    f"aggregation.batch.cross_subject: rollups[{index}].subjectId "
                    "must match batch subjectId"
                )
            if rollup.deviceId != self.deviceId:
                raise ValueError(
                    f"aggregation.batch.cross_device: rollups[{index}].deviceId "
                    "must match batch deviceId"
                )
        return self


class AggregationBatchResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    batchId: BoundedId
    subjectId: BoundedId
    accepted: bool
    duplicate: bool
    rollupCount: int = Field(ge=0, le=MAX_BATCH_ROLLUPS)


class AggregationIngestError(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: Literal[
        "aggregation.batch_too_large",
        "aggregation.repository_unavailable",
        "aggregation.repository_timeout",
    ]
    detail: str


@runtime_checkable
class AggregationRepository(Protocol):
    def ingest_batch(self, batch: AggregationBatchRequest) -> bool:
        """Atomically persist; True when inserted, False on idempotent replay."""

    def close(self) -> None:
        """Release repository resources."""


class InMemoryAggregationRepository:
    """Concurrent, idempotent test/dev repository keyed by subject + batch."""

    backend_name = "memory"

    def __init__(self) -> None:
        self._rows: dict[tuple[str, str], AggregationBatchRequest] = {}
        self._lock = threading.RLock()

    def ingest_batch(self, batch: AggregationBatchRequest) -> bool:
        key = (batch.subjectId, batch.batchId)
        with self._lock:
            if key in self._rows:
                return False
            self._rows[key] = batch.model_copy(deep=True)
            return True

    def close(self) -> None:
        return None

    def get_batch(
        self, subject_id: str, batch_id: str
    ) -> AggregationBatchRequest | None:
        """Subject-scoped test/dev read; never scans another subject."""
        with self._lock:
            row = self._rows.get((subject_id, batch_id))
            return row.model_copy(deep=True) if row is not None else None


class PostgresAggregationRepository:
    """Postgres JSONB repository; one atomic insert per subject-scoped batch."""

    backend_name = "postgres"

    def __init__(self, dsn: str) -> None:
        from psycopg_pool import ConnectionPool

        self._pool = ConnectionPool(
            conninfo=dsn,
            min_size=1,
            max_size=8,
            timeout=5,
            open=True,
        )

    def ingest_batch(self, batch: AggregationBatchRequest) -> bool:
        payload = json.dumps(
            batch.model_dump(mode="json"),
            separators=(",", ":"),
            sort_keys=True,
        )
        with self._pool.connection() as conn, conn.transaction():
            row = conn.execute(
                """
                INSERT INTO aggregation_batches
                  (subject_id, batch_id, device_id, rollup_count, payload)
                VALUES (%s, %s, %s, %s, %s::jsonb)
                ON CONFLICT (subject_id, batch_id) DO NOTHING
                RETURNING batch_id
                """,
                (
                    batch.subjectId,
                    batch.batchId,
                    batch.deviceId,
                    len(batch.rollups),
                    payload,
                ),
            ).fetchone()
        return row is not None

    def close(self) -> None:
        self._pool.close()


def select_aggregation_repository(
    dsn: str | None,
) -> AggregationRepository:
    if dsn and dsn.strip():
        return PostgresAggregationRepository(dsn)
    return InMemoryAggregationRepository()


def get_aggregation_repository(request: Request) -> AggregationRepository:
    repository = getattr(request.app.state, "aggregation_repository", None)
    if repository is None or not isinstance(repository, AggregationRepository):
        raise HTTPException(
            status_code=503,
            detail=AggregationIngestError(
                code="aggregation.repository_unavailable",
                detail="aggregation repository unavailable",
            ).model_dump(),
        )
    return repository


AggregationRepo = Annotated[
    AggregationRepository, Depends(get_aggregation_repository)
]
CallerCtx = Annotated[CallerContext, Depends(get_caller_context)]


@router.post(
    "/v1/aggregation/batches",
    response_model=AggregationBatchResponse,
    status_code=200,
)
def ingest_aggregation_batch(
    batch: AggregationBatchRequest,
    repository: AggregationRepo,
    caller: CallerCtx,
) -> AggregationBatchResponse:
    """Validate and atomically persist a consent-attached aggregation batch."""
    enforce_operation_scope(
        caller,
        AGGREGATION_INGEST_OPERATION_SCOPE,
        route="/v1/aggregation/batches",
        subject_id=batch.subjectId,
        device_id=batch.deviceId,
    )
    enforce_subject_scope(
        caller,
        batch.subjectId,
        route="/v1/aggregation/batches",
        source="body",
        device_id=batch.deviceId,
    )
    encoded_bytes = len(
        batch.model_dump_json(exclude_none=True).encode("utf-8")
    )
    if len(batch.rollups) > MAX_BATCH_ROLLUPS or encoded_bytes > MAX_BATCH_BYTES:
        logger.warning(
            "aggregation_ingest outcome=rejected failure_class=batch_too_large "
            "subject_id=%s device_id=%s rollup_count=%d bytes=%d",
            batch.subjectId,
            batch.deviceId,
            len(batch.rollups),
            encoded_bytes,
        )
        raise HTTPException(
            status_code=413,
            detail=AggregationIngestError(
                code="aggregation.batch_too_large",
                detail="aggregation batch exceeds bounded ingest limits",
            ).model_dump(),
        )

    try:
        inserted = repository.ingest_batch(batch)
    except TimeoutError as exc:
        logger.error(
            "aggregation_ingest outcome=error failure_class=repository_timeout "
            "subject_id=%s device_id=%s",
            batch.subjectId,
            batch.deviceId,
        )
        raise HTTPException(
            status_code=504,
            detail=AggregationIngestError(
                code="aggregation.repository_timeout",
                detail="aggregation repository timed out",
            ).model_dump(),
        ) from exc

    logger.info(
        "aggregation_ingest outcome=%s subject_id=%s device_id=%s "
        "rollup_count=%d duplicate=%s",
        "accepted" if inserted else "duplicate",
        batch.subjectId,
        batch.deviceId,
        len(batch.rollups),
        not inserted,
    )
    return AggregationBatchResponse(
        batchId=batch.batchId,
        subjectId=batch.subjectId,
        accepted=True,
        duplicate=not inserted,
        rollupCount=len(batch.rollups),
    )
