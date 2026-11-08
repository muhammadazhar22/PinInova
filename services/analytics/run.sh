#!/usr/bin/env sh
# Start the analytics service on port 8000 (override with PORT). Run from anywhere.
set -eu
cd "$(dirname "$0")"
exec python -m uvicorn pinpulse_analytics.api:app --host "${HOST:-0.0.0.0}" --port "${PORT:-8000}" "$@"
