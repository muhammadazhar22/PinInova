"""Write the OpenAPI document to services/analytics/openapi.json.

Usage: python -m pinpulse_analytics.export_openapi [--out PATH] [--check]
`--check` exits non-zero when the committed file is stale (for CI).
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys

from .api import app

DEFAULT = pathlib.Path(__file__).resolve().parents[1] / "openapi.json"


def render() -> str:
    return json.dumps(app.openapi(), indent=2, sort_keys=True) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=pathlib.Path, default=DEFAULT)
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args()
    text = render()
    if a.check:
        ok = a.out.exists() and a.out.read_text() == text
        print("openapi.json up to date" if ok
              else "openapi.json is stale: run python -m pinpulse_analytics.export_openapi")
        return 0 if ok else 1
    a.out.write_text(text)
    print(f"wrote {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
