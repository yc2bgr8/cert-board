FROM python:3.12-slim-bookworm@sha256:935c3c5b12357a7e10caa9c1e6ca5692344d97cf229832ef584be2cec9fc03df AS dependencies
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PIP_DISABLE_PIP_VERSION_CHECK=1 UV_NO_CACHE=1
COPY --from=ghcr.io/astral-sh/uv:0.13.9@sha256:d3b601f0c7b118bc1753febf7c41cc80981df678445e0254284eecf84db79a7d /uv /usr/local/bin/uv
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev --no-install-project
COPY fetcher.py ./

FROM dependencies AS test
RUN uv sync --locked --group test --no-install-project
COPY tests tests
CMD ["/app/.venv/bin/python", "-m", "pytest", "-q"]

FROM dependencies AS runtime
USER 65532:65532
CMD ["/app/.venv/bin/uvicorn", "fetcher:app", "--host", "0.0.0.0", "--port", "28084", "--no-access-log", "--limit-concurrency", "16"]
