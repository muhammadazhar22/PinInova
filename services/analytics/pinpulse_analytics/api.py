"""FastAPI wrapper. Stateless: the web app POSTs ONE tenant's data per request; nothing is stored or logged
(request bodies are never logged), and this service never calls Pinterest (CLAUDE.md non-negotiables 1-2)."""
from __future__ import annotations

from fastapi import FastAPI, HTTPException

from . import __version__
from .auth import SharedSecretAuth
from .csv_parse import CsvError, parse_csv
from .detectors import diagnose
from .duplicates import DuplicatesError, find_duplicates
from .preflight import PreflightError, run_preflight
from .schemas import (
    CsvParseRequest,
    CsvParseResponse,
    DiagnoseRequest,
    DiagnoseResponse,
    DuplicatesRequest,
    DuplicatesResponse,
    Health,
    PreflightRequest,
    PreflightResponse,
    WeatherRequest,
    WeatherResponse,
)
from .weather import weather

app = FastAPI(title="pinpulse-analytics", version=__version__,
              description="Stateless detection and diagnosis engine for PinPulse. One tenant per request; "
                          "nothing is stored; no Pinterest calls.")
app.add_middleware(SharedSecretAuth)


@app.get("/healthz", response_model=Health)
def healthz() -> Health:
    return Health(ok=True, version=__version__)


@app.post("/v1/diagnose", response_model=DiagnoseResponse, response_model_by_alias=True)
def diagnose_endpoint(body: DiagnoseRequest) -> DiagnoseResponse:
    return diagnose(body)


@app.post("/v1/csv/parse", response_model=CsvParseResponse)
def csv_parse_endpoint(body: CsvParseRequest) -> CsvParseResponse:
    try:
        return CsvParseResponse.model_validate(parse_csv(body.csv, body.kind))
    except CsvError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e


@app.post("/v1/duplicates", response_model=DuplicatesResponse)
def duplicates_endpoint(body: DuplicatesRequest) -> DuplicatesResponse:
    # policy: PA-03 - hashes computed transiently; only returned when return_hashes is true
    try:
        out = find_duplicates([(i.pin_id, i.image_base64, i.phash) for i in body.items], body.threshold,
                              body.return_hashes)
    except DuplicatesError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    return DuplicatesResponse.model_validate(out)


@app.post("/v1/weather", response_model=WeatherResponse)
def weather_endpoint(body: WeatherRequest) -> WeatherResponse:
    # policy: PA-06 - inputs are voluntary user reports only
    out = weather([(w.date.isoformat(), w.reports, w.active_reporters) for w in body.windows], body.base_rate,
                  body.phi)
    return WeatherResponse.model_validate(out)


@app.post("/v1/preflight", response_model=PreflightResponse)
def preflight_endpoint(body: PreflightRequest) -> PreflightResponse:
    try:
        findings = run_preflight([d.model_dump() for d in body.drafts],
                                 [h.model_dump() for h in body.history] if body.history else None, body.now)
    except PreflightError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    return PreflightResponse.model_validate({"findings": findings})
