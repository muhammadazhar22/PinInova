FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY pyproject.toml .
COPY pinpulse_analytics ./pinpulse_analytics
RUN pip install --no-cache-dir ".[api]"
COPY . .
RUN useradd --system --uid 10001 app && chown -R app /app
USER app
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz').status==200 else 1)"
# --no-access-log: request bodies are never logged anyway; access logs are not needed for a pure compute service
CMD ["uvicorn", "pinpulse_analytics.api:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2", "--no-access-log"]
