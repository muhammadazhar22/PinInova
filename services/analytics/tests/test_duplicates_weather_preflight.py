import base64
import io
from math import comb, log

import numpy as np
import pytest
from PIL import Image, ImageDraw
from scipy.special import betaln

from pinpulse_analytics.duplicates import find_duplicates, hamming_pairs
from pinpulse_analytics.preflight import normalize_url, run_preflight
from pinpulse_analytics.weather import day_stats, estimate_phi, weather

# --------------------------------------------------------------------------- duplicates


def _photo(seed: int) -> Image.Image:
    rng = np.random.default_rng(seed)
    base = rng.integers(0, 255, (16, 16, 3), dtype=np.uint8)
    return Image.fromarray(base).resize((320, 320), Image.Resampling.BILINEAR)


def _b64(im: Image.Image, fmt: str = "PNG", **kw) -> str:
    buf = io.BytesIO()
    im.convert("RGB").save(buf, fmt, **kw)
    return base64.b64encode(buf.getvalue()).decode()


def test_duplicates_identical_reencoded_overlay_and_different():
    im = _photo(1)
    overlay = im.copy()
    ImageDraw.Draw(overlay).text((10, 290), "SALE 20% OFF", fill=(255, 255, 255))
    items = [("orig", _b64(im), None), ("same", _b64(im), None), ("jpeg", _b64(im, "JPEG", quality=60), None),
             ("text", _b64(overlay), None), ("other", _b64(_photo(2)), None)]
    out = find_duplicates(items, threshold=8, return_hashes=True)
    assert out["clusters"] == [["orig", "same", "jpeg", "text"]]
    assert out["duplicate_rate"] == pytest.approx(3 / 5)
    assert set(out["hashes"]) == {"orig", "same", "jpeg", "text", "other"}


def test_duplicates_hashes_hidden_by_default_and_phash_input():
    out = find_duplicates([("a", None, "ffffffffffffffff"), ("b", None, "fffffffffffffff0"),
                           ("c", None, "0000000000000000"), ("d", None, None)], threshold=4)
    assert out["clusters"] == [["a", "b"]] and out["hashes"] is None
    assert out["duplicate_rate"] == pytest.approx(1 / 3)


def test_hamming_pairs_matches_bruteforce():
    rng = np.random.default_rng(0)
    h = rng.integers(0, 2**63, 300, dtype=np.int64).astype(np.uint64)
    h[5] = h[7] ^ np.uint64(0b111)
    got = set(hamming_pairs(h, 10, block=64))
    want = {(i, j) for i in range(300) for j in range(i + 1, 300) if bin(int(h[i]) ^ int(h[j])).count("1") <= 10}
    assert got == want and (5, 7) in got


# --------------------------------------------------------------------------- weather


def test_weather_binomial_hand_computed():
    # n = 50, p0 = 0.0017, k = 3: P(K >= 3) = 1 - sum_{i<3} C(50,i) p^i (1-p)^(50-i)
    p = 0.0017
    tail = 1 - sum(comb(50, i) * p**i * (1 - p) ** (50 - i) for i in range(3))
    frac, lbf, tp = day_stats(3, 50, p, None)
    assert frac == pytest.approx(0.06)
    assert tp == pytest.approx(tail, rel=1e-9)
    assert 9e-5 < tp < 2e-4  # the plan's "near 1e-4"
    want = betaln(1 + 3, 20 + 47) - betaln(1, 20) - (3 * log(p) + 47 * log(1 - p))
    assert lbf == pytest.approx(want, rel=1e-9)


def test_weather_levels_and_insufficient():
    out = weather([("2026-11-01", 0, 60), ("2026-11-02", 3, 50), ("2026-11-03", 8, 50), ("2026-11-04", 2, 4)])
    lv = [d["level"] for d in out["days"]]
    assert lv == ["normal", "elevated", "platform_wide", "normal"]
    assert out["days"][3]["insufficient"] is True and out["model"] == "binomial"


def test_weather_overdispersion_reduces_significance():
    rng = np.random.default_rng(4)
    n = np.full(60, 80)
    # overdispersed background: daily rate itself varies around ~0.01
    k = rng.binomial(n, rng.beta(0.5, 49.5, 60))
    phi = estimate_phi(k.astype(float), n.astype(float), 0.0017)
    assert phi is not None and phi > 0
    _, _, tail_bin = day_stats(4, 80, 0.0017, None)
    _, _, tail_bb = day_stats(4, 80, 0.0017, phi)
    assert tail_bb > tail_bin
    hist = [(f"2026-09-{i % 28 + 1:02d}", int(a), int(b)) for i, (a, b) in enumerate(zip(k, n))]
    assert weather(hist)["model"] == "beta_binomial"
    assert estimate_phi(np.zeros(5), np.full(5, 50.0), 0.0017) is None  # too little history -> binomial


# --------------------------------------------------------------------------- preflight

NOW = "2026-11-08T12:00:00Z"


def _rules(findings, idx=None):
    return {f["rule_id"] for f in findings if idx is None or f["draft_index"] == idx}


def _d(**kw):
    base = {"title": "Easy sourdough", "description": "A simple loaf.", "link": "https://bakes.com/sourdough",
            "board": "Bread", "scheduled_at": None, "image_ref": None}
    base.update(kw)
    return base


def test_clean_draft_has_no_findings():
    assert run_preflight([_d()], None, NOW) == []


def test_same_url_within_7_days_history_and_drafts():
    hist = [{"link": "https://www.bakes.com/sourdough/?utm_source=pinterest", "created_at": "2026-11-05T00:00:00Z"}]
    f = run_preflight([_d(), _d(link="https://bakes.com/other"), _d(link="https://bakes.com/other",
                                                                   scheduled_at="2026-11-10T00:00:00Z")], hist, NOW)
    assert _rules(f, 0) == {"same_url_7d"} and _rules(f, 1) == set() and _rules(f, 2) == {"same_url_7d"}
    assert all(x["source"] == "vendor" for x in f if x["rule_id"] == "same_url_7d")
    assert run_preflight([_d()], [{"link": "https://bakes.com/sourdough", "created_at": "2026-10-01T00:00:00Z"}],
                         NOW) == []
    assert normalize_url("HTTPS://WWW.Bakes.com/a/?utm_medium=x#top") == normalize_url("bakes.com/a")


def test_bulk_day():
    drafts = [_d(link=f"https://bakes.com/{i}", scheduled_at="2026-11-20T09:00:00Z") for i in range(26)]
    f = [x for x in run_preflight(drafts, None, NOW) if x["rule_id"] == "bulk_day"]
    assert len(f) == 1 and f[0]["draft_index"] is None and f[0]["source"] == "hypothesis" and "26" in f[0]["message"]
    assert not any(x["rule_id"] == "bulk_day" for x in run_preflight(drafts[:25], None, NOW))


def test_ad_prefix_not_adventure():
    assert "ad_prefix" in _rules(run_preflight([_d(description="  #AD Sponsored loaf")], None, NOW))
    assert "ad_prefix" not in _rules(run_preflight([_d(description="#adventure bread")], None, NOW))


def test_keyword_stuffing():
    stuffed = _d(description="bread bread bread bread recipe easy bread")
    assert "keyword_stuffing" in _rules(run_preflight([stuffed], None, NOW))
    tags = _d(description=" ".join(f"#tag{i}" for i in range(12)))
    assert "keyword_stuffing" in _rules(run_preflight([tags], None, NOW))
    rep = _d(description="#bread loaf #bread")
    f = [x for x in run_preflight([rep], None, NOW) if x["rule_id"] == "keyword_stuffing"]
    assert f and f[0]["source"] == "official"


def test_shortener_and_redirect():
    f = run_preflight([_d(link="https://bit.ly/abc"), _d(link="https://bakes.com/out?url=https%3A%2F%2Fevil.com"),
                       _d(link="https://bakes.com/redirect/123")], None, NOW)
    assert _rules(f, 0) == {"link_shortener"}
    assert _rules(f, 1) == {"redirect_link"} and _rules(f, 2) == {"redirect_link"}
    assert [x["severity"] for x in f if x["draft_index"] == 0] == ["error"]


def test_title_length_missing_link_and_bait():
    f = run_preflight([_d(title="x" * 101), _d(link=""),
                       _d(description="Save this pin to win a mixer!", link="https://bakes.com/2"),
                       _d(title="Follow for follow bakers", link="https://bakes.com/3")], None, NOW)
    assert _rules(f, 0) == {"title_length"} and _rules(f, 1) == {"missing_link"}
    assert _rules(f, 2) == {"engagement_bait"} and _rules(f, 3) == {"engagement_bait"}
    sev = {x["rule_id"]: x["severity"] for x in f}
    assert sev["missing_link"] == "info" and sev["title_length"] == "error"
    assert all(x["policy_ref"] for x in f)
    assert "12 Nov 2026" in next(x["policy_ref"] for x in f if x["rule_id"] == "engagement_bait")
