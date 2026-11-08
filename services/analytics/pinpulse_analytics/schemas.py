"""HTTP contract (pydantic v2). snake_case JSON, shared with apps/web.

Every request carries ONE tenant's data and nothing is stored (CLAUDE.md non-negotiable 2).
Specs: SPEC-010 (CSV import), SPEC-011..014 (diagnose), SPEC-021 (pre-flight, duplicates), SPEC-030 (weather).
"""
from __future__ import annotations

import datetime as dt
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

MIN_POINTS = 14
MAX_POINTS = 560  # API gives 90 days; CSV imports cover "the past year and a half"

Count = Annotated[float, Field(ge=0, allow_inf_nan=False)]
Series = Annotated[list[Count], Field(min_length=MIN_POINTS, max_length=MAX_POINTS)]
Fraction = Annotated[float, Field(ge=0, le=1, allow_inf_nan=False)]
Finite = Annotated[float, Field(allow_inf_nan=False)]

CauseClass = Literal["A_enforcement", "B_quality", "C_behavioural", "D_platform", "E_decay", "M_measurement"]
CAUSES: tuple[CauseClass, ...] = ("A_enforcement", "B_quality", "C_behavioural", "D_platform", "E_decay",
                                  "M_measurement")
AGE_KEYS = ("0-7", "8-14", "15-29", "30+")


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


# --------------------------------------------------------------------------- #
# /v1/diagnose
# --------------------------------------------------------------------------- #

class AgeBuckets(_Model):
    """Daily impressions of Pins grouped by Pin age (days since publish) at that date."""
    age_0_7: list[Count] | None = Field(default=None, alias="0-7")
    age_8_14: list[Count] | None = Field(default=None, alias="8-14")
    age_15_29: list[Count] | None = Field(default=None, alias="15-29")
    age_30_plus: list[Count] | None = Field(default=None, alias="30+")

    def as_dict(self) -> dict[str, list[float]]:
        vals = (self.age_0_7, self.age_8_14, self.age_15_29, self.age_30_plus)
        return {k: v for k, v in zip(AGE_KEYS, vals) if v is not None}


class DomainSeries(_Model):
    domain: str = Field(min_length=1, max_length=253)
    impressions: list[Count]


class PinTotals(_Model):
    pin_id: str = Field(min_length=1, max_length=64)
    before: Count
    after: Count


class DiagnoseSignals(_Model):
    domain_block_error: bool = False
    visit_site_demoted: bool | None = None
    bulk_upload_or_ad_prefix: bool = False
    duplicate_url_rate_14d: Fraction = 0.0
    peers_hit_fraction: Fraction | None = None          # weather index; always None in v1 (PA-06)
    yoy_same_window_ratio: Annotated[float, Field(ge=0, allow_inf_nan=False)] | None = None
    ga4_pinterest_vs_direct_gap: Finite | None = None
    linked_new_impr: Count | None = None                 # matched-pair experiment means, if run
    unlinked_new_impr: Count | None = None


class DiagnoseRequest(_Model):
    dates: list[dt.date] | None = None
    impressions: Series
    outbound_clicks: Series
    saves: Series | None = None
    pin_clicks: Series | None = None
    provisional_days: int = Field(default=2, ge=0, le=7)   # policy: PA-08 (PROVISIONAL_DAYS)
    age_buckets: AgeBuckets | None = None
    domains: Annotated[list[DomainSeries], Field(max_length=200)] | None = None
    unlinked_impressions: Series | None = None
    pins: Annotated[list[PinTotals], Field(max_length=20_000)] | None = None
    signals: DiagnoseSignals | None = None
    min_drop: float = Field(default=0.5, gt=0, lt=1)

    @model_validator(mode="after")
    def _lengths(self) -> DiagnoseRequest:
        n = len(self.impressions)
        problems: list[str] = []

        def chk(name: str, seq: list | None) -> None:
            if seq is not None and len(seq) != n:
                problems.append(f"{name} has {len(seq)} points, impressions has {n}")

        chk("dates", self.dates)
        chk("outbound_clicks", self.outbound_clicks)
        chk("saves", self.saves)
        chk("pin_clicks", self.pin_clicks)
        chk("unlinked_impressions", self.unlinked_impressions)
        if self.age_buckets is not None:
            for k, v in self.age_buckets.as_dict().items():
                chk(f"age_buckets[{k}]", v)
        if self.domains is not None:
            seen: set[str] = set()
            for d in self.domains:
                chk(f"domains[{d.domain}].impressions", d.impressions)
                if d.domain.lower() in seen:
                    problems.append(f"duplicate domain {d.domain}")
                seen.add(d.domain.lower())
        if self.dates is not None and len(self.dates) == n:
            gaps = [i for i in range(1, n) if (self.dates[i] - self.dates[i - 1]).days != 1]
            if gaps:
                problems.append(f"dates must be consecutive days, oldest first (first gap at index {gaps[0]})")
        if self.pins is not None and len({p.pin_id for p in self.pins}) != len(self.pins):
            problems.append("pin_id values must be unique")
        if n - self.provisional_days < MIN_POINTS // 2:
            problems.append("provisional_days leaves fewer than 7 complete days")
        if problems:
            raise ValueError("; ".join(problems))
        return self


class DropOut(_Model):
    before_median: float
    after_median: float
    ratio: float
    effect: float


class RateOut(_Model):
    verdict: Literal["stable", "changed", "insufficient"]
    log_bf: float | None
    ctr_before: float | None
    ctr_after: float | None
    post_impressions: int


class DomainBreadth(_Model):
    domain: str
    ratio: float | None
    share_before: float


class AgeBreadth(_Model):
    age_0_7: float | None = Field(default=None, alias="0-7")
    age_8_14: float | None = Field(default=None, alias="8-14")
    age_15_29: float | None = Field(default=None, alias="15-29")
    age_30_plus: float | None = Field(default=None, alias="30+")


class BreadthOut(_Model):
    age: AgeBreadth | None = None
    domains: list[DomainBreadth] | None = None
    linked_ratio: float | None = None
    unlinked_ratio: float | None = None


class PinContribution(_Model):
    pin_id: str
    delta: float
    share: float


class ConcentrationOut(_Model):
    top1_share: float | None = None
    top_pin_share: float | None = None
    gini: float | None = None


class ClassProb(_Model):
    cause: CauseClass
    probability: float


class Evidence(_Model):
    code: str
    text: str
    supports: list[CauseClass]


class DiagnoseResponse(_Model):
    status: Literal["none", "warning", "drop"]
    onset_index: int | None
    onset_date: str | None
    warning_index: int | None
    warning_date: str | None
    drop: DropOut | None
    methods_agree: bool
    p_value: float | None
    rate: RateOut
    breadth: BreadthOut
    pin_contributions: list[PinContribution]
    concentration: ConcentrationOut
    shape: Literal["step", "fade", "unknown"]
    classes: list[ClassProb]
    evidence: list[Evidence]
    confidence: Literal["low", "medium", "high"]
    detector_version: str


# --------------------------------------------------------------------------- #
# /v1/csv/parse
# --------------------------------------------------------------------------- #

CsvKind = Literal["pinterest_analytics", "ga4_sessions", "shopify_orders", "pin_drafts"]


class CsvParseRequest(_Model):
    csv: str = Field(min_length=1, max_length=20_000_000)
    kind: CsvKind


class CsvParseResponse(_Model):
    kind: CsvKind
    rows: list[dict[str, str | float | int | None]]
    columns_matched: dict[str, str]
    warnings: list[str]
    date_range: list[str] | None


# --------------------------------------------------------------------------- #
# /v1/duplicates
# --------------------------------------------------------------------------- #

class DuplicateItem(_Model):
    pin_id: str = Field(min_length=1, max_length=64)
    image_base64: str | None = Field(default=None, max_length=20_000_000)
    phash: str | None = Field(default=None, pattern=r"^[0-9a-fA-F]{16}$")


class DuplicatesRequest(_Model):
    items: Annotated[list[DuplicateItem], Field(max_length=5000)]
    threshold: int = Field(default=8, ge=0, le=64)
    return_hashes: bool = False

    @model_validator(mode="after")
    def _unique(self) -> DuplicatesRequest:
        ids = [i.pin_id for i in self.items]
        if len(set(ids)) != len(ids):
            raise ValueError("pin_id values must be unique")
        return self


class DuplicatesResponse(_Model):
    clusters: list[list[str]]
    duplicate_rate: float
    hashes: dict[str, str] | None


# --------------------------------------------------------------------------- #
# /v1/weather
# --------------------------------------------------------------------------- #

class WeatherWindow(_Model):
    date: dt.date
    reports: int = Field(ge=0)
    active_reporters: int = Field(ge=0)

    @model_validator(mode="after")
    def _k_le_n(self) -> WeatherWindow:
        if self.reports > self.active_reporters:
            raise ValueError(f"{self.date}: reports ({self.reports}) exceed active_reporters ({self.active_reporters})")
        return self


class WeatherRequest(_Model):
    windows: Annotated[list[WeatherWindow], Field(min_length=1, max_length=2000)]
    base_rate: float = Field(default=0.0017, gt=0, lt=1)
    phi: float | None = Field(default=None, gt=0)


class WeatherDay(_Model):
    date: str
    fraction: float
    log_bf: float
    tail_p: float
    level: Literal["normal", "elevated", "platform_wide"]
    insufficient: bool = False


class WeatherResponse(_Model):
    days: list[WeatherDay]
    phi: float | None = None                       # additive: overdispersion actually used (None = binomial)
    model: Literal["binomial", "beta_binomial"] = "binomial"


# --------------------------------------------------------------------------- #
# /v1/preflight
# --------------------------------------------------------------------------- #

class PinDraft(BaseModel):
    model_config = ConfigDict(extra="ignore")   # web sends parsed CSV rows as-is (`unknown[]`)
    title: str = ""
    description: str = ""
    link: str = ""
    board: str = ""
    scheduled_at: str | None = None
    image_ref: str | None = None


class HistoryItem(_Model):
    link: str
    created_at: str


class PreflightRequest(_Model):
    drafts: Annotated[list[PinDraft], Field(max_length=5000)]
    history: Annotated[list[HistoryItem], Field(max_length=50_000)] | None = None
    now: str


class Finding(_Model):
    rule_id: str
    severity: Literal["error", "warning", "info"]
    source: Literal["official", "vendor", "hypothesis"]
    draft_index: int | None
    message: str
    policy_ref: str


class PreflightResponse(_Model):
    findings: list[Finding]


class Health(_Model):
    ok: bool
    version: str
