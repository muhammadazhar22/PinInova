import pytest

from pinpulse_analytics.csv_parse import CsvError, parse_csv, parse_number


def test_pinterest_clean():
    out = parse_csv("Date,Impressions,Outbound clicks,Pin clicks,Saves\n"
                    "2026-11-01,1000,20,30,5\n2026-11-02,900,18,25,4\n", "pinterest_analytics")
    assert out["rows"][0] == {"date": "2026-11-01", "impressions": 1000, "outbound_clicks": 20, "pin_clicks": 30,
                              "saves": 5, "engagements": None, "total_audience": None}
    assert out["columns_matched"]["outbound_clicks"] == "Outbound clicks"
    assert out["date_range"] == ["2026-11-01", "2026-11-02"]


def test_pinterest_messy_bom_semicolon_daymonth_thousands_total_preamble():
    text = ("﻿Pinterest analytics export;;\nDate range: last 30 days;;\n"
            "\"Date\";\"Impressions\";\"Outbound Clicks\";\"Engagements\"\n"
            "13/10/2026;\"1.234\";12;40\n14/10/2026;2.001;\"\";41\n15/10/2026;-;3;\n"
            "Total;3.235;15;81\n")
    out = parse_csv(text, "pinterest_analytics")
    rows = out["rows"]
    assert [r["date"] for r in rows] == ["2026-10-13", "2026-10-14", "2026-10-15"]
    assert rows[0]["impressions"] == 1234 and rows[1]["impressions"] == 2001 and rows[2]["impressions"] is None
    assert rows[1]["outbound_clicks"] is None and rows[0]["engagements"] == 40
    assert rows[0]["saves"] is None
    assert any("summary" in w for w in out["warnings"])
    assert any("before the header" in w for w in out["warnings"])
    assert out["columns_matched"]["engagements"] == "Engagements"


def test_pinterest_tab_us_dates_commas_and_duplicates():
    text = ("Date\tImpressions\tSaves\tTotal audience\n"
            "10/13/2026\t\"1,234\"\t5\t900\n10/13/2026\t100\t1\t900\n10/15/2026\t\"2,000\"\t7\t950\n")
    out = parse_csv(text, "pinterest_analytics")
    assert [r["date"] for r in out["rows"]] == ["2026-10-13", "2026-10-15"]
    assert out["rows"][0]["impressions"] == 1334 and out["rows"][0]["saves"] == 6
    assert out["rows"][0]["total_audience"] == 900
    assert any("duplicate date" in w for w in out["warnings"])
    assert any("missing" in w for w in out["warnings"])


def test_ambiguous_dates_warn():
    out = parse_csv("Date,Impressions\n01/02/2026,1\n02/03/2026,2\n", "pinterest_analytics")
    assert out["rows"][0]["date"] == "2026-01-02"
    assert any("ambiguous" in w for w in out["warnings"])


def test_pinterest_missing_required():
    with pytest.raises(CsvError, match="impressions"):
        parse_csv("Date,Saves\n2026-01-01,1\n", "pinterest_analytics")


def test_ga4_combined_source_medium_with_comments_and_yyyymmdd():
    text = ("# ----------------------------------------\n# Traffic acquisition\n# Start date: 20261101\n"
            "Date,Session source / medium,Landing page + query string,Sessions\n"
            "20261101,pinterest.com / referral,/blog/a?x=1,\"1,200\"\n"
            "20261102,(direct) / (none),/,300\n,,Grand total,1500\n")
    out = parse_csv(text, "ga4_sessions")
    assert out["rows"][0] == {"date": "2026-11-01", "source": "pinterest.com", "medium": "referral",
                              "landing_page": "/blog/a?x=1", "sessions": 1200}
    assert out["rows"][1]["source"] == "(direct)" and out["rows"][1]["medium"] == "(none)"
    assert len(out["rows"]) == 2


def test_ga4_separate_columns():
    out = parse_csv("Date;Session source;Session medium;Sessions\n2026-11-01;Pinterest;Organic;12\n", "ga4_sessions")
    r = out["rows"][0]
    assert (r["source"], r["medium"], r["landing_page"], r["sessions"]) == ("Pinterest", "Organic", None, 12)


def test_ga4_missing_sessions():
    with pytest.raises(CsvError, match="sessions"):
        parse_csv("Date,Session source\n2026-11-01,x\n", "ga4_sessions")


def test_shopify_line_items_and_utm_from_landing_site():
    text = ("Name,Email,Created at,Currency,Total,Landing Site,Lineitem name\n"
            "#1001,a@x.com,2026-11-03 14:22:10 -0500,usd,\"1,299.00\","
            "/products/x?utm_source=pinterest&utm_medium=organic&utm_campaign=fall&utm_content=pin123,Mug\n"
            "#1001,a@x.com,2026-11-03 14:22:10 -0500,usd,,,Spoon\n"
            "#1002,b@x.com,2026-11-04 09:00:00 +0100,EUR,\"12,50\",,Plate\n")
    out = parse_csv(text, "shopify_orders")
    assert len(out["rows"]) == 2
    o = out["rows"][0]
    assert o["order_id"] == "#1001" and o["created_at"] == "2026-11-03T14:22:10-05:00"
    assert o["total_price"] == 1299.0 and o["currency"] == "USD"
    assert (o["utm_source"], o["utm_medium"], o["utm_campaign"], o["utm_content"]) == ("pinterest", "organic", "fall",
                                                                                     "pin123")
    assert out["rows"][1]["total_price"] == 12.5 and out["rows"][1]["utm_source"] is None
    assert out["date_range"] == ["2026-11-03", "2026-11-04"]
    assert any("line-item" in w for w in out["warnings"])


def test_shopify_explicit_utm_columns_win():
    out = parse_csv("Order ID,Created At,Total Price,Currency,UTM Source,Landing site\n"
                    "9,2026-11-01T10:00:00Z,5,GBP,newsletter,/?utm_source=pinterest\n", "shopify_orders")
    assert out["rows"][0]["utm_source"] == "newsletter" and out["rows"][0]["created_at"] == "2026-11-01T10:00:00+00:00"


def test_shopify_missing_currency():
    with pytest.raises(CsvError, match="currency"):
        parse_csv("Name,Created at,Total\n#1,2026-01-01,5\n", "shopify_orders")


def test_pin_drafts_bulk_template():
    text = ('Title,Media URL,Pinterest board,Thumbnail,Description,Link,Publish date,Keywords\n'
            '"All about bread, part 1",https://cdn.x/a.jpg,Baking,,"Crusty, easy",https://x.com/a,'
            '2026-11-20T10:00:00,bread\n'
            'Total guide,https://cdn.x/b.jpg,Baking,,,,,\n')
    out = parse_csv(text, "pin_drafts")
    assert len(out["rows"]) == 2  # 'Total guide' is a title, not a summary row
    r = out["rows"][0]
    assert r == {"title": "All about bread, part 1", "description": "Crusty, easy", "link": "https://x.com/a",
                 "board": "Baking", "scheduled_at": "2026-11-20T10:00:00", "image_ref": "https://cdn.x/a.jpg"}
    assert out["rows"][1]["scheduled_at"] is None and out["rows"][1]["link"] == ""


def test_pin_drafts_missing_board():
    with pytest.raises(CsvError, match="board"):
        parse_csv("Title,Link\nx,https://x.com\n", "pin_drafts")


@pytest.mark.parametrize("s,integer,dec_comma,expected", [
    ("1,234", True, False, 1234), ("1.234", True, True, 1234), ("1 234", True, False, 1234),
    ("12,50", False, True, 12.5), ("1.234,56", False, True, 1234.56), ("1,234.56", False, False, 1234.56),
    ("12.5%", False, False, 12.5), ("$1,299.00", False, False, 1299.0), ("-", True, False, None),
    ("", True, False, None),
    ("(12)", False, False, -12.0),
])
def test_parse_number(s, integer, dec_comma, expected):
    assert parse_number(s, integer, dec_comma) == expected
