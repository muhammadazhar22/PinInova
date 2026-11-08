"""Tolerant CSV import for the v0 Drop Check and integrations (SPEC-010). Pure: parses text, stores nothing.

Handles: UTF-8 BOM, ',' ';' or tab separators, quoted fields, preamble lines before the header, '#' comment
lines (GA4 exports), thousands separators ("1,234", "1.234", "1 234"), decimal commas ("12,50"), percent
signs, YYYY-MM-DD / YYYYMMDD / MM/DD/YYYY / DD/MM/YYYY / DD.MM.YYYY dates (day-first vs month-first is decided
from the values of the whole column), trailing total/summary rows and duplicate dates (summed).

ASSUMPTION (not verified): Pinterest's native analytics CSV column names. We accept common aliases and report
which header matched each field in `columns_matched`; see README "Assumptions".
"""
from __future__ import annotations

import csv
import datetime as dt
import io
import re
from dataclasses import dataclass, field
from urllib.parse import parse_qs, urlparse


class CsvError(ValueError):
    """Raised for input that cannot be parsed into the requested kind (mapped to HTTP 422)."""


def _norm(h: str) -> str:
    h = h.replace("﻿", "").strip().lower()
    h = re.sub(r"[\s_\-./]+", " ", h)
    h = re.sub(r"[^a-z0-9 +]", "", h)
    return re.sub(r"\s+", " ", h).strip()


# normalized field -> accepted header aliases (compared after _norm)
ALIASES: dict[str, dict[str, list[str]]] = {
    "pinterest_analytics": {
        "date": ["date", "day", "date utc", "reporting date"],
        "impressions": ["impressions", "impression", "total impressions", "pin impressions"],
        "outbound_clicks": ["outbound clicks", "outbound click", "link clicks", "website clicks", "outbound"],
        "pin_clicks": ["pin clicks", "pin click", "closeups", "closeup", "close ups"],
        "saves": ["saves", "save", "repins", "repin"],
        "engagements": ["engagements", "engagement", "total engagements"],
        "total_audience": ["total audience", "audience", "monthly total audience"],
    },
    "ga4_sessions": {
        "date": ["date", "day"],
        "source_medium": ["session source medium", "source medium", "session source  medium",
                          "first user source medium", "session sourcemedium"],
        "source": ["session source", "source", "first user source"],
        "medium": ["session medium", "medium", "first user medium"],
        "landing_page": ["landing page", "landing page + query string", "landing page query string", "page path",
                         "landing page path"],
        "sessions": ["sessions", "session"],
    },
    "shopify_orders": {
        "order_id": ["name", "order", "order id", "order name", "order number", "id"],
        "created_at": ["created at", "created", "order date", "date", "processed at"],
        "total_price": ["total", "total price", "order total", "total sales", "amount"],
        "currency": ["currency", "currency code", "presentment currency"],
        "utm_source": ["utm source", "source utm"],
        "utm_medium": ["utm medium"],
        "utm_campaign": ["utm campaign"],
        "utm_content": ["utm content"],
        "landing_site": ["landing site", "landing page", "landing site ref", "landing url"],
    },
    "pin_drafts": {
        "title": ["title", "pin title", "name"],
        "description": ["description", "pin description", "desc"],
        "link": ["link", "url", "destination link", "destination url", "website", "website link"],
        "board": ["board", "pinterest board", "board name"],
        "scheduled_at": ["publish date", "scheduled at", "schedule", "scheduled", "publish at", "date"],
        "image_ref": ["media url", "image", "image url", "media", "image ref", "thumbnail"],
    },
}

REQUIRED: dict[str, list[list[str]]] = {   # each inner list: at least one of these fields
    "pinterest_analytics": [["date"], ["impressions"]],
    "ga4_sessions": [["date"], ["sessions"], ["source", "source_medium"]],
    "shopify_orders": [["order_id"], ["created_at"], ["total_price"], ["currency"]],
    "pin_drafts": [["title"], ["board"]],
}

NUMERIC: dict[str, set[str]] = {
    "pinterest_analytics": {"impressions", "outbound_clicks", "pin_clicks", "saves", "engagements", "total_audience"},
    "ga4_sessions": {"sessions"},
    "shopify_orders": {"total_price"},
    "pin_drafts": set(),
}

TOTAL_RE = re.compile(r"^\s*(grand\s+)?(total|totals|sum|summary|overall|all dates|all time)\s*[:.]?\s*$", re.I)
NULLS = {"", "-", "--", "n/a", "na", "null", "none", "—"}


@dataclass
class _Ctx:
    warnings: list[str] = field(default_factory=list)

    def warn(self, msg: str) -> None:
        if msg not in self.warnings:
            self.warnings.append(msg)


COMMENT_RE = re.compile(r"^\s*#(\s|-|#|$)")   # GA4 "# Start date" lines; not "#1001" Shopify order names


def _sniff_delimiter(lines: list[str]) -> str:
    sample = [ln for ln in lines[:30] if ln.strip() and not COMMENT_RE.match(ln)]
    best, best_score = ",", -1.0
    for d in (",", ";", "\t"):
        counts = [len(next(csv.reader([ln], delimiter=d))) for ln in sample]
        if not counts:
            continue
        mode = max(set(counts), key=counts.count)
        score = counts.count(mode) * (mode - 1)
        if mode > 1 and score > best_score:
            best, best_score = d, score
    return best


def _match_headers(row: list[str], kind: str) -> dict[str, int]:
    aliases = ALIASES[kind]
    out: dict[str, int] = {}
    normed = [_norm(c) for c in row]
    for fld, names in aliases.items():
        targets = {_norm(a) for a in names}
        for i, h in enumerate(normed):
            if h in targets and i not in out.values():
                out[fld] = i
                break
    return out


def parse_number(s: str | None, integer_hint: bool, decimal_comma: bool = False) -> float | None:
    """Parse '1,234', '1.234', '1 234', '12,50', '12.5%', '$1,299.00'. None for blanks."""
    if s is None:
        return None
    t = s.strip().replace(" ", " ").replace(" ", " ")
    if t.lower() in NULLS:
        return None
    neg = t.startswith("(") and t.endswith(")")
    t = re.sub(r"[^\d,.\-+ ]", "", t).strip().replace(" ", "")
    if neg:
        t = "-" + t.lstrip("-")
    if not re.search(r"\d", t):
        return None
    if "," in t and "." in t:
        if t.rfind(",") > t.rfind("."):
            t = t.replace(".", "").replace(",", ".")
        else:
            t = t.replace(",", "")
    elif "," in t:
        if re.fullmatch(r"[-+]?\d{1,3}(,\d{3})+", t) and (integer_hint or not decimal_comma):
            t = t.replace(",", "")
        elif t.count(",") == 1:
            t = t.replace(",", ".")
        else:
            t = t.replace(",", "")
    elif t.count(".") > 1 or (integer_hint and re.fullmatch(r"[-+]?\d{1,3}(\.\d{3})+", t)):
        t = t.replace(".", "")
    try:
        return float(t)
    except ValueError:
        return None


_DATE_PATTERNS = [
    (re.compile(r"^(\d{4})-(\d{1,2})-(\d{1,2})"), "ymd"),
    (re.compile(r"^(\d{4})/(\d{1,2})/(\d{1,2})"), "ymd"),
    (re.compile(r"^(\d{4})(\d{2})(\d{2})$"), "ymd"),
    (re.compile(r"^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})"), "amb"),
    (re.compile(r"^(\d{1,2})/(\d{1,2})/(\d{2})$"), "amb2"),
]
_MONTHS = {m: i for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov",
                                        "dec"], start=1)}
_MON_RE = re.compile(r"^(?:[a-z]{3,9},?\s+)?([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})", re.I)
_DMON_RE = re.compile(r"^(\d{1,2})\s+([a-z]{3})[a-z]*\.?,?\s+(\d{4})", re.I)


def _date_parts(s: str) -> tuple[str, int, int, int] | None:
    t = s.strip().strip('"')
    for rx, kind in _DATE_PATTERNS:
        m = rx.match(t)
        if m:
            a, b, c = (int(g) for g in m.groups())
            if kind == "amb2":
                return "amb", a, b, 2000 + c
            if kind == "ymd":
                return "ymd", a, b, c
            return "amb", a, b, c
    m = _MON_RE.match(t)
    if m and m.group(1).lower() in _MONTHS:
        return "ymd", int(m.group(3)), _MONTHS[m.group(1).lower()], int(m.group(2))
    m = _DMON_RE.match(t)
    if m and m.group(2).lower() in _MONTHS:
        return "ymd", int(m.group(3)), _MONTHS[m.group(2).lower()], int(m.group(1))
    return None


def _decide_day_first(values: list[str], ctx: _Ctx, col: str) -> bool:
    """For ambiguous a/b/yyyy dates: day-first if any first part > 12, month-first if any second part > 12;
    otherwise month-first with a warning (US default)."""
    firsts, seconds = [], []
    for v in values:
        p = _date_parts(v)
        if p and p[0] == "amb":
            firsts.append(p[1])
            seconds.append(p[2])
    if not firsts:
        return False
    if any(f > 12 for f in firsts) and not any(s > 12 for s in seconds):
        return True
    if any(s > 12 for s in seconds):
        return False
    ctx.warn(f"Dates in '{col}' are ambiguous (every day and month are <= 12); assumed month/day/year.")
    return False


def parse_date(s: str | None, day_first: bool) -> dt.date | None:
    if s is None or s.strip().lower() in NULLS:
        return None
    p = _date_parts(s)
    if p is None:
        return None
    kind, a, b, c = p
    try:
        if kind == "ymd":
            return dt.date(a, b, c)
        return dt.date(c, b, a) if day_first else dt.date(c, a, b)
    except ValueError:
        return None


_TIME_RE = re.compile(r"[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2}|UTC)?\s*$", re.I)


def parse_datetime(s: str | None, day_first: bool) -> str | None:
    """ISO 8601 string (with offset when the source had one) or None."""
    d = parse_date(s, day_first)
    if d is None or s is None:
        return None
    m = _TIME_RE.search(s.strip())
    if not m:
        return d.isoformat()
    hh, mm, ss = int(m.group(1)), int(m.group(2)), int(m.group(3) or 0)
    tz = m.group(4)
    out = dt.datetime(d.year, d.month, d.day, hh, mm, ss).isoformat()
    if tz:
        if tz.upper() in ("Z", "UTC"):
            out += "+00:00"
        else:
            tz = tz.replace(":", "")
            out += f"{tz[:3]}:{tz[3:]}"
    return out


def _utm_from_url(url: str | None) -> dict[str, str | None]:
    out: dict[str, str | None] = {k: None for k in ("utm_source", "utm_medium", "utm_campaign", "utm_content")}
    if not url:
        return out
    u = url.strip()
    if u.startswith("/"):
        u = "https://x" + u
    try:
        q = parse_qs(urlparse(u).query)
    except ValueError:
        return out
    for k in out:
        if q.get(k):
            out[k] = q[k][0]
    return out


def _read_rows(text: str, ctx: _Ctx) -> tuple[list[list[str]], str]:
    text = text.lstrip("﻿").replace("\r\n", "\n").replace("\r", "\n")
    lines = text.split("\n")
    delim = _sniff_delimiter(lines)
    body = "\n".join(ln for ln in lines if not COMMENT_RE.match(ln))
    rows = [r for r in csv.reader(io.StringIO(body), delimiter=delim, skipinitialspace=True)]
    rows = [r for r in rows if any(c.strip() for c in r)]
    if delim != ",":
        ctx.warn(f"Detected '{'tab' if delim == chr(9) else delim}' as the column separator.")
    return rows, delim


def parse_csv(text: str, kind: str) -> dict:  # noqa: C901
    ctx = _Ctx()
    rows, delim = _read_rows(text, ctx)
    if not rows:
        raise CsvError("The file is empty.")
    header_i, cols = None, {}
    for i, r in enumerate(rows[:30]):
        m = _match_headers(r, kind)
        needed = sum(1 for group in REQUIRED[kind] if any(g in m for g in group))
        if needed >= 1 and (len(m) >= 2 or needed == len(REQUIRED[kind]) or len(r) <= 3):
            header_i, cols = i, m
            break
    if header_i is None:
        raise CsvError(f"Could not find a header row for {kind}: expected columns like "
                       + ", ".join(ALIASES[kind][g[0]][0].title() for g in REQUIRED[kind]) + ".")
    if header_i > 0:
        ctx.warn(f"Skipped {header_i} line(s) before the header row.")
    header = rows[header_i]
    missing = [" or ".join(g) for g in REQUIRED[kind] if not any(x in cols for x in g)]
    if missing:
        raise CsvError(f"Missing required column(s) for {kind}: {', '.join(missing)}. Found: "
                       + ", ".join(h.strip() for h in header if h.strip()) + ".")
    matched = {f: header[i].replace("﻿", "").strip() for f, i in cols.items()}
    data = rows[header_i + 1:]
    decimal_comma = delim == ";"

    def cell(r: list[str], f: str) -> str | None:
        i = cols.get(f)
        if i is None or i >= len(r):
            return None
        v = r[i].strip()
        return None if v.lower() in NULLS else v

    date_field = {"pinterest_analytics": "date", "ga4_sessions": "date", "shopify_orders": "created_at",
                  "pin_drafts": "scheduled_at"}[kind]
    first_col = min(cols.values())

    # drop trailing/embedded summary rows
    kept: list[list[str]] = []
    dropped = 0
    for r in data:
        label = r[first_col] if first_col < len(r) else ""
        lead = r[0] if r else ""
        if kind != "pin_drafts" and (TOTAL_RE.match(label or "") or TOTAL_RE.match(lead or "")):
            dropped += 1
            continue
        if date_field in cols and kind in ("pinterest_analytics", "ga4_sessions"):
            if cell(r, date_field) is None:
                dropped += 1
                continue
        kept.append(r)
    if dropped:
        ctx.warn(f"Ignored {dropped} total/summary or blank-date row(s).")

    day_first = False
    if date_field in cols:
        day_first = _decide_day_first([cell(r, date_field) or "" for r in kept], ctx, matched[date_field])

    numeric = NUMERIC[kind]
    out_rows: list[dict] = []
    bad_dates = 0
    if kind == "pinterest_analytics":
        by_date: dict[dt.date, dict] = {}
        dups = 0
        for r in kept:
            d = parse_date(cell(r, "date"), day_first)
            if d is None:
                bad_dates += 1
                continue
            rec: dict = {"date": d.isoformat()}
            for f in ("impressions", "outbound_clicks", "pin_clicks", "saves", "engagements", "total_audience"):
                rec[f] = parse_number(cell(r, f), True, decimal_comma) if f in cols else None
            if d in by_date:
                dups += 1
                prev = by_date[d]
                for f in numeric:
                    if f == "total_audience":
                        continue
                    if rec[f] is not None:
                        prev[f] = (prev[f] or 0) + rec[f]
            else:
                by_date[d] = rec
        if dups:
            ctx.warn(f"{dups} duplicate date row(s) were summed (e.g. one row per device or format).")
        out_rows = [by_date[d] for d in sorted(by_date)]
        for rec in out_rows:
            for f in ("impressions", "outbound_clicks", "pin_clicks", "saves", "engagements"):
                if rec[f] is not None and float(rec[f]).is_integer():
                    rec[f] = int(rec[f])
            if rec["total_audience"] is not None and float(rec["total_audience"]).is_integer():
                rec["total_audience"] = int(rec["total_audience"])
        if out_rows:
            ds = [dt.date.fromisoformat(r["date"]) for r in out_rows]
            gaps = sum((b - a).days - 1 for a, b in zip(ds, ds[1:]) if (b - a).days > 1)
            if gaps:
                ctx.warn(f"{gaps} day(s) are missing between {ds[0]} and {ds[-1]}; they are not filled in.")
            for f in ("outbound_clicks", "pin_clicks", "saves"):
                if f not in cols:
                    ctx.warn(f"No column for {f}; values are null.")
    elif kind == "ga4_sessions":
        for r in kept:
            d = parse_date(cell(r, "date"), day_first)
            if d is None:
                bad_dates += 1
                continue
            src, med = cell(r, "source"), cell(r, "medium")
            if "source_medium" in cols and (src is None or med is None):
                sm = cell(r, "source_medium") or ""
                if "/" in sm:
                    a, b = sm.split("/", 1)
                    src, med = src or a.strip(), med or b.strip()
                else:
                    src = src or (sm.strip() or None)
            sessions = parse_number(cell(r, "sessions"), True, decimal_comma)
            out_rows.append({"date": d.isoformat(), "source": src or "(not set)", "medium": med or "(not set)",
                             "landing_page": cell(r, "landing_page"),
                             "sessions": int(sessions) if sessions is not None and sessions.is_integer() else sessions})
        out_rows.sort(key=lambda r: r["date"])
    elif kind == "shopify_orders":
        seen: dict[str, dict] = {}
        line_items = 0
        for r in kept:
            oid = cell(r, "order_id")
            if oid is None:
                continue
            total = parse_number(cell(r, "total_price"), False, decimal_comma)
            if oid in seen:
                line_items += 1
                if seen[oid]["total_price"] is None and total is not None:
                    seen[oid]["total_price"] = total
                continue
            land = cell(r, "landing_site")
            utm = _utm_from_url(land)
            rec = {"order_id": oid, "created_at": parse_datetime(cell(r, "created_at"), day_first),
                   "total_price": total, "currency": (cell(r, "currency") or "").upper() or None,
                   "landing_site": land}
            for k in ("utm_source", "utm_medium", "utm_campaign", "utm_content"):
                rec[k] = cell(r, k) if k in cols and cell(r, k) is not None else utm[k]
            if rec["created_at"] is None:
                bad_dates += 1
            seen[oid] = rec
        if line_items:
            ctx.warn(f"Merged {line_items} extra line-item row(s) into their orders.")
        out_rows = list(seen.values())
        if any(r["currency"] is None for r in out_rows):
            ctx.warn("Some orders have no currency value.")
    elif kind == "pin_drafts":
        for f in ("description", "link"):
            if f not in cols:
                ctx.warn(f"No column for {f}; values are empty.")
        for r in kept:
            title = cell(r, "title")
            board = cell(r, "board")
            if title is None and board is None:
                continue
            sched_raw = cell(r, "scheduled_at")
            sched = parse_datetime(sched_raw, day_first) if sched_raw else None
            if sched_raw and sched is None:
                bad_dates += 1
            out_rows.append({"title": title or "", "description": cell(r, "description") or "",
                             "link": cell(r, "link") or "", "board": board or "", "scheduled_at": sched,
                             "image_ref": cell(r, "image_ref")})
    if bad_dates:
        ctx.warn(f"{bad_dates} row(s) had an unreadable date and were "
                 + ("skipped." if kind in ("pinterest_analytics", "ga4_sessions") else "kept with a null date."))
    if not out_rows:
        raise CsvError(f"No data rows could be parsed for {kind}.")

    date_vals: list[str] = []
    for rec in out_rows:
        v = rec.get(date_field)
        if v:
            date_vals.append(v[:10])
    date_range = [min(date_vals), max(date_vals)] if date_vals else None
    return {"kind": kind, "rows": out_rows, "columns_matched": matched, "warnings": ctx.warnings,
            "date_range": date_range}
