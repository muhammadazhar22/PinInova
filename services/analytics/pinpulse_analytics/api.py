"""FastAPI wrapper. The web app POSTs per-user series; nothing is stored here."""
from __future__ import annotations

import numpy as np
from fastapi import FastAPI
from pydantic import BaseModel, Field

from .detectors import Signals, diagnose

app = FastAPI(title="pinpulse-analytics", version="0.1.0")


class DiagnoseIn(BaseModel):
    impressions: list[float] = Field(min_length=14, max_length=90)
    outbound_clicks: list[float]
    new_pins_impressions: list[float] | None = None
    old_pins_impressions: list[float] | None = None
    linked_new_impr: float | None = None
    unlinked_new_impr: float | None = None
    domain_block_error: bool = False
    visit_site_demoted: bool | None = None
    bulk_upload_or_ad_prefix: bool = False
    duplicate_url_rate_14d: float = 0.0
    peers_hit_fraction: float | None = None
    yoy_same_window_ratio: float | None = None
    ga4_pinterest_vs_direct_gap: float | None = None


@app.post("/v1/diagnose")
def diagnose_endpoint(body: DiagnoseIn) -> dict:
    d = body.model_dump()
    for k in ("impressions", "outbound_clicks", "new_pins_impressions", "old_pins_impressions"):
        if d[k] is not None:
            d[k] = np.asarray(d[k], dtype=float)
    dg = diagnose(Signals(**d))
    return {
        "onset_index": dg.onset_index,
        "drop": None if dg.drop is None else dg.drop.__dict__,
        "rate_shift_log_bf": dg.rate_shift_log_bf,
        "classes": dg.ranked,
        "evidence": dg.evidence,
    }


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True}
