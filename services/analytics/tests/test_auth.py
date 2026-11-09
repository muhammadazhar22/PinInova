"""Shared-secret auth (SPEC-075): every route except /healthz needs `Authorization: Bearer <ANALYTICS_TOKEN>`
when ANALYTICS_TOKEN is set. Unset = local dev/tests only; the production compose refuses to start without it."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from pinpulse_analytics.api import app

TOKEN = "t" * 40
BODY = {"windows": [{"date": "2026-01-01", "reports": 0, "active_reporters": 10}]}


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("ANALYTICS_TOKEN", TOKEN)
    return TestClient(app)


def test_rejects_missing_token(client: TestClient) -> None:
    r = client.post("/v1/weather", json=BODY)
    assert r.status_code == 401
    assert r.headers["www-authenticate"] == "Bearer"


def test_rejects_wrong_token(client: TestClient) -> None:
    r = client.post("/v1/weather", json=BODY, headers={"Authorization": "Bearer " + "x" * 40})
    assert r.status_code == 401


def test_rejects_non_bearer_scheme(client: TestClient) -> None:
    r = client.post("/v1/weather", json=BODY, headers={"Authorization": "Basic " + TOKEN})
    assert r.status_code == 401


def test_accepts_correct_token(client: TestClient) -> None:
    r = client.post("/v1/weather", json=BODY, headers={"Authorization": f"Bearer {TOKEN}"})
    assert r.status_code == 200


def test_docs_and_openapi_are_protected(client: TestClient) -> None:
    assert client.get("/openapi.json").status_code == 401
    assert client.get("/docs").status_code == 401


def test_healthz_stays_open_for_container_healthchecks(client: TestClient) -> None:
    assert client.get("/healthz").status_code == 200


def test_short_token_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANALYTICS_TOKEN", "short")
    r = TestClient(app).post("/v1/weather", json=BODY, headers={"Authorization": "Bearer short"})
    assert r.status_code == 500


def test_open_when_unset_for_local_dev(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ANALYTICS_TOKEN", raising=False)
    assert TestClient(app).post("/v1/weather", json=BODY).status_code == 200
