"""Pre-flight checks on draft Pins (SPEC-021). Pure rules over drafts the user supplied; no Pinterest calls.

policy: PA-04 - every rule is labelled `official` (Pinterest text), `vendor` (third-party advice) or
`hypothesis` (community reports); thresholds are PinInova's own and say so. No cross-account comparison.
Rules were re-read against the Community Guidelines update effective 12 Nov 2026 (docs/PLAN.md section 2).
"""
from __future__ import annotations

import datetime as dt
import re
from collections import Counter
from urllib.parse import parse_qsl, unquote, urlencode, urlparse, urlunparse

SAME_URL_DAYS = 7
BULK_PER_DAY = 25
TITLE_MAX = 100
TOKEN_REPEAT = 4
TOKEN_DENSITY = 0.10
MAX_HASHTAGS = 10

SHORTENERS = {
    "bit.ly", "bitly.com", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "is.gd", "buff.ly", "rebrand.ly", "cutt.ly",
    "shorturl.at", "tiny.cc", "bl.ink", "rb.gy", "t.ly", "v.gd", "soo.gd", "s.id", "lnkd.in", "shorte.st", "adf.ly",
    "bc.vc", "ouo.io", "short.io", "trib.al", "dlvr.it", "amzn.to", "pin.it",
}
REDIRECT_KEYS = {"url", "redirect", "redirect_url", "redirect_uri", "redir", "next", "goto", "dest", "destination",
                 "target", "out", "u", "link", "to", "continue", "return", "returnurl", "r"}
REDIRECT_PATH = re.compile(r"/(redirect|redir|out|go|outbound|click|track|r)(/|\.php|$)", re.I)
BAIT = [
    r"save\s+(this\s+)?pin\s+to\s+win", r"repin\s+to\s+win", r"save\s+to\s+win", r"comment\s+to\s+win",
    r"follow\s+for\s+(a\s+)?follow", r"\bf4f\b", r"\bfollow\s*4\s*follow\b", r"like\s+and\s+repin",
    r"repin\s+and\s+like", r"like\s*(,|and|&)\s*save", r"follow\s+back\b", r"save\s+for\s+save", r"\bs4s\b",
    r"tag\s+\d+\s+friends", r"share\s+to\s+win",
]
BAIT_RE = re.compile("|".join(BAIT), re.I)
STOP = {"the", "and", "for", "with", "you", "your", "this", "that", "from", "are", "how", "what", "our", "can",
        "will", "all", "get", "has", "have", "into", "out", "its", "it's", "was", "but", "not", "more", "best"}

REF = {
    "same_url_7d": ("vendor", "Vendor guidance, not a Pinterest rule: Tailwind's scheduling advice is to space Pins "
                    "that point to the same URL; the 7-day window is PinInova's setting. Pinterest's Community "
                    "Guidelines separately discourage repetitive content ('create, save, or distribute', 12 Nov "
                    "2026 update)."),
    "bulk_day": ("hypothesis", "Hypothesis from creator reports, not a published Pinterest rule: large same-day "
                 "publishing spikes may look like bulk or automated activity. The 25-per-day threshold is "
                 "PinInova's."),
    "ad_prefix": ("hypothesis", "Hypothesis from Pinterest Business Community reports that Pins whose description "
                  "starts with '#ad' lose distribution; Pinterest has not documented this."),
    "keyword_stuffing": ("official", "Pinterest Community Guidelines, spam: repetitive or keyword-stuffed content. "
                         "The repetition and hashtag thresholds are PinInova heuristics, not Pinterest numbers."),
    "link_shortener": ("official", "Pinterest Community Guidelines, spam and misleading links (the 'no surprises' "
                       "rule, kept in the 12 Nov 2026 update). Treating shorteners and redirect parameters as "
                       "deceptive-redirection risk is PinInova's reading of that rule."),
    "redirect_link": ("official", "Pinterest Community Guidelines, spam and misleading links (the 'no surprises' "
                      "rule, kept in the 12 Nov 2026 update). Treating redirect parameters as deceptive-redirection "
                      "risk is PinInova's reading of that rule."),
    "title_length": ("official", "Pinterest API v5 Pin create: title is limited to 100 characters."),
    "missing_link": ("official", "Informational, not a violation: a Pin without a link cannot send outbound clicks "
                     "(Pinterest allows Pins without links)."),
    "engagement_bait": ("official", "Pinterest Community Guidelines effective 12 Nov 2026 (preview): 'Scams, "
                        "deceptive goods, and practices' covers engagement manipulation 'through automated, paid, or "
                        "incentivized means'."),
}


class PreflightError(ValueError):
    pass


def parse_ts(s: str | None) -> dt.datetime | None:
    if not s or not s.strip():
        return None
    t = s.strip().replace("Z", "+00:00")
    try:
        d = dt.datetime.fromisoformat(t)
    except ValueError:
        try:
            d = dt.datetime.combine(dt.date.fromisoformat(t[:10]), dt.time())
        except ValueError:
            return None
    return d if d.tzinfo else d.replace(tzinfo=dt.UTC)


def normalize_url(u: str) -> str | None:
    """Comparable key: lower-case host without www., no fragment, no utm_* / tracking params, no trailing slash."""
    u = (u or "").strip()
    if not u:
        return None
    if "://" not in u:
        u = "https://" + u
    try:
        p = urlparse(u)
    except ValueError:
        return None
    host = (p.hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    q = [(k, v) for k, v in parse_qsl(p.query, keep_blank_values=True)
         if not k.lower().startswith("utm_") and k.lower() not in {"fbclid", "gclid", "epik", "mc_cid", "mc_eid"}]
    path = p.path.rstrip("/") or "/"
    return urlunparse(("https", host, path, "", urlencode(sorted(q)), ""))


def _host(u: str) -> str:
    if "://" not in u:
        u = "https://" + u
    try:
        h = (urlparse(u).hostname or "").lower()
    except ValueError:
        return ""
    return h[4:] if h.startswith("www.") else h


def _redirect_like(u: str) -> str | None:
    if "://" not in u:
        u = "https://" + u
    try:
        p = urlparse(u)
    except ValueError:
        return None
    for k, v in parse_qsl(p.query, keep_blank_values=True):
        vv = unquote(v).lower()
        if k.lower() in REDIRECT_KEYS and ("://" in vv or vv.startswith("www.")):
            return f"query parameter '{k}' carries another URL"
    m = REDIRECT_PATH.search(p.path)
    if m and ("http" in unquote(p.path + "?" + p.query).lower()[1:] or m.group(1).lower() in ("redirect", "redir")):
        return f"path '{p.path}' looks like a redirect endpoint"
    return None


def _tokens(text: str) -> list[str]:
    return [t for t in re.findall(r"[#]?[\w']+", text.lower()) if len(t.lstrip("#")) >= 3]


def run_preflight(drafts: list[dict], history: list[dict] | None, now: str) -> list[dict]:  # noqa: C901
    now_ts = parse_ts(now)
    if now_ts is None:
        raise PreflightError("now must be an ISO 8601 timestamp")
    findings: list[dict] = []

    def add(rule: str, severity: str, idx: int | None, msg: str) -> None:
        src, ref = REF[rule]
        findings.append({"rule_id": rule, "severity": severity, "source": src, "draft_index": idx,
                         "message": msg, "policy_ref": ref})

    when = []
    for d in drafts:
        ts = parse_ts(d.get("scheduled_at"))
        when.append(ts or now_ts)

    # same URL within 7 days (history + earlier drafts)
    events: list[tuple[dt.datetime, str, int | None]] = []
    for h in history or []:
        key, ts = normalize_url(h.get("link", "")), parse_ts(h.get("created_at"))
        if key and ts:
            events.append((ts, key, None))
    for i, d in enumerate(drafts):
        key = normalize_url(d.get("link", ""))
        if key:
            events.append((when[i], key, i))
    events.sort(key=lambda e: (e[0], -1 if e[2] is None else e[2]))
    last_seen: dict[str, tuple[dt.datetime, int | None]] = {}
    for ts, key, idx in events:
        prev = last_seen.get(key)
        if idx is not None and prev is not None and (ts - prev[0]) < dt.timedelta(days=SAME_URL_DAYS):
            gap = (ts - prev[0]).total_seconds() / 86400
            what = "a Pin already published" if prev[1] is None else f"draft {prev[1]}"
            add("same_url_7d", "warning", idx, f"Links to the same URL as {what} only {gap:.1f} days earlier; "
                f"space Pins to one URL at least {SAME_URL_DAYS} days apart.")
        last_seen[key] = (ts, idx)

    # bulk day
    per_day = Counter(w.astimezone(dt.UTC).date() for w in when)
    for day, c in sorted(per_day.items()):
        if c > BULK_PER_DAY:
            add("bulk_day", "warning", None, f"{c} drafts are scheduled on {day.isoformat()} (more than "
                f"{BULK_PER_DAY}); consider spreading them over several days.")

    for i, d in enumerate(drafts):
        title, desc, link = d.get("title") or "", d.get("description") or "", (d.get("link") or "").strip()
        if re.match(r"^\s*#ad\b", desc, re.I):
            add("ad_prefix", "warning", i, "Description starts with '#ad'.")
        toks = _tokens(f"{title} {desc}")
        words = [t for t in toks if not t.startswith("#") and t not in STOP]
        tags = [t for t in toks if t.startswith("#")]
        wc = Counter(words)
        tc = Counter(tags)
        top = wc.most_common(1)
        reasons = []
        if top and top[0][1] >= TOKEN_REPEAT and top[0][1] / max(len(words), 1) >= TOKEN_DENSITY:
            reasons.append(f"'{top[0][0]}' appears {top[0][1]} times")
        if len(tags) > MAX_HASHTAGS:
            reasons.append(f"{len(tags)} hashtags")
        rep = [t for t, c in tc.items() if c >= 2]
        if rep:
            reasons.append("repeated hashtag " + ", ".join(sorted(rep)[:3]))
        if reasons:
            add("keyword_stuffing", "warning", i, "Possible keyword stuffing: " + "; ".join(reasons) + ".")
        if link:
            host = _host(link)
            if host in SHORTENERS:
                add("link_shortener", "error", i, f"Link uses the shortener/redirect service {host}; link to the "
                    "final destination instead.")
            else:
                why = _redirect_like(link)
                if why:
                    add("redirect_link", "warning", i, f"Link looks like a redirect ({why}); link to the final "
                        "destination instead.")
        else:
            add("missing_link", "info", i, "Draft has no link.")
        if len(title) > TITLE_MAX:
            add("title_length", "error", i, f"Title is {len(title)} characters; the limit is {TITLE_MAX}.")
        m = BAIT_RE.search(f"{title}\n{desc}")
        if m:
            add("engagement_bait", "error", i, f"Engagement bait: '{m.group(0)}'.")
    findings.sort(key=lambda f: (f["draft_index"] if f["draft_index"] is not None else -1,
                                 {"error": 0, "warning": 1, "info": 2}[f["severity"]], f["rule_id"]))
    return findings
