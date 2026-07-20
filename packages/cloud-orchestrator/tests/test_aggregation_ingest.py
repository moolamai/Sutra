"""Aggregation batch ingest: strict validation, idempotency, and isolation."""

from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from sutra_orchestrator.auth import (
    AGGREGATION_INGEST_OPERATION_SCOPE,
    CallerContext,
    PermissiveDevVerifier,
    SYNC_OPERATION_SCOPE,
    StaticApiKeyVerifier,
    get_caller_context,
)
from sutra_orchestrator.routes.aggregation import (
    AggregationBatchResponse,
    InMemoryAggregationRepository,
    router,
)


def _rollup(
    *,
    subject_id: str = "learner-a",
    device_id: str = "edge-dev1",
) -> dict[str, object]:
    return {
        "schemaVersion": "aggregation.v1",
        "subjectId": subject_id,
        "deviceId": device_id,
        "consentRecordId": "consent-aggregation-001",
        "locality": "on-device",
        "rolledUpAt": "001700000000100:000002:edge-dev1",
        "sampleCount": 2,
        "concepts": [
            {
                "conceptId": "ratios",
                "sampleCount": 2,
                "hesitationMsSum": 2000,
                "hesitationMsMax": 1200,
                "inputVelocitySum": 7.5,
                "revisionCountSum": 1,
                "assistanceRequestedCount": 0,
                "outcomes": {
                    "correct": 1,
                    "partial": 1,
                    "incorrect": 0,
                    "ungraded": 0,
                },
            }
        ],
    }


def _batch(
    *,
    batch_id: str = "batch-aggregation-001",
    subject_id: str = "learner-a",
    device_id: str = "edge-dev1",
) -> dict[str, object]:
    return {
        "batchId": batch_id,
        "subjectId": subject_id,
        "deviceId": device_id,
        "rollups": [
            _rollup(subject_id=subject_id, device_id=device_id)
        ],
    }


def _client(repository: object | None = None) -> tuple[TestClient, object]:
    app = FastAPI()
    repo = repository or InMemoryAggregationRepository()
    app.state.aggregation_repository = repo
    app.dependency_overrides[get_caller_context] = lambda: CallerContext(
        principalId="aggregation-test",
        subjectScope=["learner-a", "learner-b"],
        operationScopes=[AGGREGATION_INGEST_OPERATION_SCOPE],
    )
    app.include_router(router)
    return TestClient(app), repo


def test_happy_path_persists_subject_scoped_batch_and_response_round_trips() -> None:
    client, repository = _client()
    response = client.post("/v1/aggregation/batches", json=_batch())

    assert response.status_code == 200
    parsed = AggregationBatchResponse.model_validate(response.json())
    assert parsed.accepted is True
    assert parsed.duplicate is False
    assert parsed.rollupCount == 1

    stored = repository.get_batch("learner-a", "batch-aggregation-001")
    assert stored is not None
    assert stored.subjectId == "learner-a"
    assert stored.rollups[0].consentRecordId == "consent-aggregation-001"
    assert repository.get_batch("learner-b", "batch-aggregation-001") is None


def test_replayed_batch_is_idempotent_per_subject() -> None:
    client, repository = _client()
    first = client.post("/v1/aggregation/batches", json=_batch())
    replay = client.post("/v1/aggregation/batches", json=_batch())
    other_subject = client.post(
        "/v1/aggregation/batches",
        json=_batch(subject_id="learner-b"),
    )

    assert first.status_code == 200
    assert replay.status_code == 200
    assert replay.json()["duplicate"] is True
    assert other_subject.status_code == 200
    assert other_subject.json()["duplicate"] is False
    assert repository.get_batch("learner-a", "batch-aggregation-001")
    assert repository.get_batch("learner-b", "batch-aggregation-001")


def test_concurrent_replay_inserts_exactly_once() -> None:
    repository = InMemoryAggregationRepository()
    client, _ = _client(repository)

    with ThreadPoolExecutor(max_workers=8) as pool:
        responses = list(
            pool.map(
                lambda _: client.post(
                    "/v1/aggregation/batches", json=_batch()
                ),
                range(16),
            )
        )

    assert all(response.status_code == 200 for response in responses)
    assert sum(not response.json()["duplicate"] for response in responses) == 1


def test_cross_subject_rollup_is_422_and_nothing_is_persisted() -> None:
    client, repository = _client()
    payload = _batch()
    payload["rollups"][0]["subjectId"] = "learner-b"

    response = client.post("/v1/aggregation/batches", json=payload)

    assert response.status_code == 422
    assert "aggregation.batch.cross_subject" in response.text
    assert repository.get_batch("learner-a", "batch-aggregation-001") is None
    assert repository.get_batch("learner-b", "batch-aggregation-001") is None


def test_authenticated_caller_outside_subject_scope_is_403() -> None:
    app = FastAPI()
    repository = InMemoryAggregationRepository()
    app.state.aggregation_repository = repository
    app.dependency_overrides[get_caller_context] = lambda: CallerContext(
        principalId="other-teacher",
        subjectScope=["learner-b"],
        operationScopes=[AGGREGATION_INGEST_OPERATION_SCOPE],
    )
    app.include_router(router)

    response = TestClient(app).post(
        "/v1/aggregation/batches", json=_batch(subject_id="learner-a")
    )

    assert response.status_code == 403
    assert repository.get_batch("learner-a", "batch-aggregation-001") is None


def test_missing_credential_is_401_before_persistence() -> None:
    app = FastAPI()
    repository = InMemoryAggregationRepository()
    app.state.aggregation_repository = repository
    app.state.auth_verifier = StaticApiKeyVerifier(
        {
            "valid-key": CallerContext(
                principalId="aggregation-client",
                subjectScope=["learner-a"],
                operationScopes=[AGGREGATION_INGEST_OPERATION_SCOPE],
            )
        }
    )
    app.include_router(router)

    response = TestClient(app).post(
        "/v1/aggregation/batches", json=_batch()
    )

    assert response.status_code == 401
    assert repository.get_batch("learner-a", "batch-aggregation-001") is None


def _authenticated_app(
    verifier: object,
) -> tuple[TestClient, InMemoryAggregationRepository]:
    app = FastAPI()
    repository = InMemoryAggregationRepository()
    app.state.aggregation_repository = repository
    app.state.auth_verifier = verifier
    app.include_router(router)
    return TestClient(app), repository


def test_sync_only_key_is_403_for_aggregation_ingest() -> None:
    client, repository = _authenticated_app(
        StaticApiKeyVerifier(
            {
                "sync-key": CallerContext(
                    principalId="sync-client",
                    subjectScope=["learner-a"],
                    operationScopes=[SYNC_OPERATION_SCOPE],
                )
            }
        )
    )

    response = client.post(
        "/v1/aggregation/batches",
        json=_batch(),
        headers={"X-API-Key": "sync-key"},
    )

    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "FORBIDDEN_OPERATION_SCOPE"
    assert repository.get_batch("learner-a", "batch-aggregation-001") is None


def test_aggregation_key_is_200_and_subject_scoped() -> None:
    client, repository = _authenticated_app(
        StaticApiKeyVerifier(
            {
                "ingest-key": CallerContext(
                    principalId="aggregation-client",
                    subjectScope=["learner-a"],
                    operationScopes=[AGGREGATION_INGEST_OPERATION_SCOPE],
                )
            }
        )
    )

    response = client.post(
        "/v1/aggregation/batches",
        json=_batch(),
        headers={"X-API-Key": "ingest-key"},
    )

    assert response.status_code == 200
    assert response.json()["accepted"] is True
    assert repository.get_batch("learner-a", "batch-aggregation-001")


def test_permissive_dev_verifier_grants_explicit_all_operation_scope(
    caplog: pytest.LogCaptureFixture,
) -> None:
    verifier = PermissiveDevVerifier(warn=False)
    client, repository = _authenticated_app(verifier)

    with caplog.at_level(logging.INFO):
        response = client.post(
            "/v1/aggregation/batches",
            json=_batch(),
            headers={"Authorization": "Bearer local-dev-token"},
        )

    assert response.status_code == 200
    assert repository.get_batch("learner-a", "batch-aggregation-001")
    joined = " ".join(record.getMessage() for record in caplog.records)
    assert "operation_scope=aggregation:ingest" in joined
    assert "subject_id=learner-a" in joined
    assert "device_id=edge-dev1" in joined
    assert "local-dev-token" not in joined
    assert "prompt" not in joined


def test_unknown_or_raw_content_fields_are_422_before_persistence() -> None:
    client, repository = _client()
    payload = _batch()
    payload["rollups"][0]["prompt"] = "learner plaintext"

    response = client.post("/v1/aggregation/batches", json=payload)

    assert response.status_code == 422
    assert repository.get_batch("learner-a", "batch-aggregation-001") is None


def test_inconsistent_rollup_counts_are_422() -> None:
    client, _ = _client()
    payload = _batch()
    payload["rollups"][0]["sampleCount"] = 3

    response = client.post("/v1/aggregation/batches", json=payload)

    assert response.status_code == 422
    assert "aggregation.rollup.sample_count" in response.text


def test_oversized_batch_is_413_without_partial_persistence() -> None:
    client, repository = _client()
    payload = _batch()
    payload["rollups"] = [
        _rollup() for _ in range(101)
    ]

    response = client.post("/v1/aggregation/batches", json=payload)

    assert response.status_code == 413
    assert response.json()["detail"]["code"] == "aggregation.batch_too_large"
    assert repository.get_batch("learner-a", "batch-aggregation-001") is None


class _TimeoutRepository:
    def ingest_batch(self, _batch: object) -> bool:
        raise TimeoutError("database deadline")

    def close(self) -> None:
        return None


def test_repository_timeout_is_typed_504() -> None:
    client, _ = _client(_TimeoutRepository())

    response = client.post("/v1/aggregation/batches", json=_batch())

    assert response.status_code == 504
    assert (
        response.json()["detail"]["code"]
        == "aggregation.repository_timeout"
    )


def test_response_model_rejects_unknown_fields() -> None:
    payload = {
        "batchId": "batch-aggregation-001",
        "subjectId": "learner-a",
        "accepted": True,
        "duplicate": False,
        "rollupCount": 1,
        "rawPrompt": "forbidden",
    }
    try:
        AggregationBatchResponse.model_validate(payload)
    except ValidationError as exc:
        assert "rawPrompt" in str(exc)
    else:
        raise AssertionError("response model silently accepted an unknown field")
