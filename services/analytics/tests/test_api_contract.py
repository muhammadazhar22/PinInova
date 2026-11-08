"""Contract tests: shapes and status codes exactly as the web app expects (snake_case JSON)."""
from __future__ import annotations

import base64
import datetime as dt
import io

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from pinpulse_analytics.api import app
from pinpulse_analytics.detectors import DETECTOR_VERSION
from pinpulse_analytics.synth import iter_benchmark

client = TestClient(app)
START = dt.date(2026, 1, 1)

DIAG_KEYS = {"status", "onset_index", "onset_date", "warning_index", "warning_date", "drop", "methods_agree",
             "p_value", "rate", "breadth", "pin_contributions", "concentration", "shape", "classes", "evidence",
             "confidence", "detector_version"}
CAUSES = {"A_enforcement", "B_quality", "C_behavioural", "D_platform", "E_decay", "M_measurement"}


def _cliff_request(drop: float = 0.85, n: int = 90, onset: int = 60, seed: int = 0, **extra) -> dict:
    rng = np.random.default_rng(seed)
    t = np.arange(n)
    mean = 5000 * (1 + 0.1 * np.sin(2 * np.pi * t / 7)) * np.where(t >= onset, 1 - drop, 1.0)
    imp = rng.poisson(mean).astype(float)
    clicks = rng.binomial(imp.astype(int), 0.02).astype(float)
    req = {"impressions": imp.tolist(), "outbound_clicks": clicks.tolist(),
           "dates": [(START + dt.timedelta(days=i)).isoformat() for i in range(n)]}
    req.update(extra)
    return req


def test_healthz():
    r = client.get("/healthz")
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"ok", "version"} and body["ok"] is True and isinstance(body["version"], str)


def test_diagnose_drop_shape():
    r = client.post("/v1/diagnose", json=_cliff_request())
    assert r.status_code == 200
    b = r.json()
    assert set(b) == DIAG_KEYS
    assert b["status"] == "drop"
    assert abs(b["onset_index"] - 60) <= 2
    assert b["onset_date"] == (START + dt.timedelta(days=b["onset_index"])).isoformat()
    assert set(b["drop"]) == {"before_median", "after_median", "ratio", "effect"}
    assert abs(b["drop"]["effect"] - (1 - b["drop"]["ratio"])) < 1e-9
    assert set(b["rate"]) == {"verdict", "log_bf", "ctr_before", "ctr_after", "post_impressions"}
    assert b["rate"]["verdict"] == "stable" and isinstance(b["rate"]["post_impressions"], int)
    assert set(b["breadth"]) == {"age", "domains", "linked_ratio", "unlinked_ratio"}
    assert set(b["concentration"]) == {"top1_share", "top_pin_share", "gini"}
    assert b["shape"] in {"step", "fade", "unknown"}
    probs = [c["probability"] for c in b["classes"]]
    assert {c["cause"] for c in b["classes"]} == CAUSES and probs == sorted(probs, reverse=True)
    assert abs(sum(probs) - 1) < 1e-9
    for e in b["evidence"]:
        assert set(e) == {"code", "text", "supports"} and set(e["supports"]) <= CAUSES and e["text"]
    assert b["confidence"] in {"low", "medium", "high"}
    assert b["detector_version"] == DETECTOR_VERSION
    assert 0 <= b["p_value"] < 0.01
    assert b["pin_contributions"] == []


def test_diagnose_none_shape():
    rng = np.random.default_rng(3)
    req = {"impressions": rng.poisson(5000, 90).astype(float).tolist(),
           "outbound_clicks": rng.poisson(150, 90).astype(float).tolist()}
    b = client.post("/v1/diagnose", json=req).json()
    assert set(b) == DIAG_KEYS
    assert b["status"] == "none" and b["drop"] is None and b["classes"] == [] and b["onset_index"] is None
    assert b["onset_date"] is None and b["warning_date"] is None
    assert b["rate"]["verdict"] == "insufficient" and b["rate"]["post_impressions"] == 0


def test_diagnose_full_breadth_payload_from_synth():
    acc = next(a for a in iter_benchmark(7, 40) if a.truth.cls == "A_enforcement" and a.breadth)
    first = client.post("/v1/diagnose", json=acc.request_at()).json()
    assert first["status"] == "drop"
    req = acc.request_at(onset_hint=first["onset_index"])
    req["signals"]["ga4_pinterest_vs_direct_gap"] = 0.1
    b = client.post("/v1/diagnose", json=req).json()
    assert set(b["breadth"]["age"]) == {"0-7", "8-14", "15-29", "30+"}
    assert all(set(d) == {"domain", "ratio", "share_before"} for d in b["breadth"]["domains"])
    assert 1 <= len(b["pin_contributions"]) <= 20
    assert all(set(p) == {"pin_id", "delta", "share"} for p in b["pin_contributions"])
    deltas = [p["delta"] for p in b["pin_contributions"]]
    assert deltas == sorted(deltas)
    assert b["concentration"]["gini"] is not None


def test_diagnose_warning_on_recent_drop():
    # drop in the last 4 days: only 2 complete post days, so not confirmable; CUSUM warns
    req = _cliff_request(drop=0.9, onset=86)
    b = client.post("/v1/diagnose", json=req).json()
    assert b["status"] == "warning"
    assert b["warning_index"] is not None and b["warning_index"] >= 86
    assert b["warning_date"] is not None and b["drop"] is None and b["classes"] == []
    assert any(e["code"] == "early_warning" for e in b["evidence"])


def test_diagnose_provisional_days_respected():
    # 6 post days of which 2 provisional -> 4 complete -> not confirmable; with provisional_days=0 it is
    req = _cliff_request(drop=0.9, onset=84)
    assert client.post("/v1/diagnose", json={**req, "provisional_days": 2}).json()["status"] != "drop"
    assert client.post("/v1/diagnose", json={**req, "provisional_days": 0}).json()["status"] == "drop"


@pytest.mark.parametrize("mutate", [
    lambda r: r.update(outbound_clicks=r["outbound_clicks"][:-1]),
    lambda r: r.update(saves=[1.0] * 10),
    lambda r: r.update(dates=r["dates"][:-1]),
    lambda r: r.update(age_buckets={"0-7": [1.0] * 5}),
    lambda r: r.update(domains=[{"domain": "a.com", "impressions": [1.0] * 3}]),
    lambda r: r.update(unlinked_impressions=[1.0] * 3),
    lambda r: r.update(impressions=[1.0] * 13, outbound_clicks=[1.0] * 13, dates=None),
    lambda r: r.update(impressions=[1.0] * 561, outbound_clicks=[1.0] * 561, dates=None),
    lambda r: r.update(impressions=[-1.0] + r["impressions"][1:]),
    lambda r: r.update(min_drop=1.5),
    lambda r: r.update(dates=r["dates"][:10] + r["dates"][11:] + ["2027-01-01"]),
    lambda r: r.update(unknown_field=1),
    lambda r: r.update(age_buckets={"0-6": [1.0] * 90}),
])
def test_diagnose_422(mutate):
    req = _cliff_request()
    mutate(req)
    assert client.post("/v1/diagnose", json=req).status_code == 422


def test_diagnose_accepts_560_points_and_omitted_optionals():
    rng = np.random.default_rng(1)
    n = 560
    imp = rng.poisson(2000, n).astype(float)
    r = client.post("/v1/diagnose", json={"impressions": imp.tolist(), "outbound_clicks": (imp * 0.02).tolist(),
                                          "saves": None, "pin_clicks": None, "signals": None})
    assert r.status_code == 200 and r.json()["status"] in {"none", "warning"}


def test_csv_parse_shape_and_422():
    csv_text = "Date,Impressions,Outbound clicks,Saves\n2026-11-01,1000,20,5\n2026-11-02,900,18,4\n"
    r = client.post("/v1/csv/parse", json={"csv": csv_text, "kind": "pinterest_analytics"})
    assert r.status_code == 200
    b = r.json()
    assert set(b) == {"kind", "rows", "columns_matched", "warnings", "date_range"}
    assert b["date_range"] == ["2026-11-01", "2026-11-02"]
    assert set(b["rows"][0]) >= {"date", "impressions", "outbound_clicks", "pin_clicks", "saves"}
    assert b["rows"][0]["pin_clicks"] is None
    r = client.post("/v1/csv/parse", json={"csv": "Foo,Bar\n1,2\n", "kind": "pinterest_analytics"})
    assert r.status_code == 422 and "header" in r.json()["detail"].lower()
    r = client.post("/v1/csv/parse", json={"csv": "Date,Clicks\n2026-01-01,1\n", "kind": "pinterest_analytics"})
    assert r.status_code == 422 and "impressions" in r.json()["detail"]
    assert client.post("/v1/csv/parse", json={"csv": "a", "kind": "nope"}).status_code == 422


def _png(seed: int) -> str:
    rng = np.random.default_rng(seed)
    im = Image.fromarray(rng.integers(0, 255, (64, 64, 3), dtype=np.uint8)).resize((256, 256))
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode()


def test_duplicates_shape():
    img = _png(1)
    r = client.post("/v1/duplicates", json={"items": [{"pin_id": "1", "image_base64": img},
                                                      {"pin_id": "2", "image_base64": img},
                                                      {"pin_id": "3", "phash": "0000000000000000"}]})
    assert r.status_code == 200
    b = r.json()
    assert set(b) == {"clusters", "duplicate_rate", "hashes"}
    assert b["clusters"] == [["1", "2"]] and b["hashes"] is None
    assert abs(b["duplicate_rate"] - 1 / 3) < 1e-9
    b2 = client.post("/v1/duplicates", json={"items": [{"pin_id": "1", "image_base64": img}],
                                             "return_hashes": True}).json()
    assert set(b2["hashes"]) == {"1"} and len(b2["hashes"]["1"]) == 16
    assert client.post("/v1/duplicates", json={"items": [{"pin_id": "1", "image_base64": "bm90IGFuIGltYWdl"}]}
                       ).status_code == 422
    assert client.post("/v1/duplicates", json={"items": [{"pin_id": "1", "phash": "xyz"}]}).status_code == 422
    assert client.post("/v1/duplicates", json={"items": [{"pin_id": "1"}, {"pin_id": "1"}]}).status_code == 422


def test_weather_shape():
    r = client.post("/v1/weather", json={"windows": [{"date": "2026-11-01", "reports": 3, "active_reporters": 50},
                                                     {"date": "2026-11-02", "reports": 0, "active_reporters": 2}]})
    assert r.status_code == 200
    b = r.json()
    assert set(b) == {"days", "phi", "model"}
    assert all(set(d) == {"date", "fraction", "log_bf", "tail_p", "level", "insufficient"} for d in b["days"])
    assert b["days"][1]["insufficient"] is True and b["days"][1]["level"] == "normal"
    bad = {"windows": [{"date": "2026-11-01", "reports": 9, "active_reporters": 5}]}
    assert client.post("/v1/weather", json=bad).status_code == 422


def test_preflight_shape():
    r = client.post("/v1/preflight", json={"drafts": [{"title": "x" * 120, "description": "", "link": "",
                                                       "board": "b"}], "now": "2026-11-08T00:00:00Z"})
    assert r.status_code == 200
    f = r.json()["findings"]
    assert {x["rule_id"] for x in f} == {"title_length", "missing_link"}
    for x in f:
        assert set(x) == {"rule_id", "severity", "source", "draft_index", "message", "policy_ref"}
        assert x["source"] in {"official", "vendor", "hypothesis"} and x["policy_ref"]
    assert client.post("/v1/preflight", json={"drafts": [], "now": "yesterday"}).status_code == 422


def test_openapi_file_is_current():
    from pinpulse_analytics.export_openapi import DEFAULT, render
    assert DEFAULT.read_text() == render(), "run python -m pinpulse_analytics.export_openapi"
