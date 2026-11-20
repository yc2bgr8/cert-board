FROM python:3.12-slim-bookworm@sha256:935c3c5b12357a7e10caa9c1e6ca5692344d97cf229832ef584be2cec9fc03df AS dependencies
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PYTHONNOUSERSITE=1 UV_NO_CACHE=1 \
    HOME=/scratch TMPDIR=/scratch OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1
RUN apt-get -o Acquire::Retries=5 update \
    && DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=5 install --no-install-recommends -y \
      libreoffice-writer libreoffice-calc fonts-dejavu-core fonts-noto-cjk libseccomp2 libgomp1 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.13.9@sha256:d3b601f0c7b118bc1753febf7c41cc80981df678445e0254284eecf84db79a7d /uv /usr/local/bin/uv
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,id=cert-board-sandbox-uv,target=/root/.cache/uv,sharing=locked \
    UV_NO_CACHE=0 UV_LINK_MODE=copy uv sync --locked --no-dev --no-install-project
COPY sandbox.py runner.py isolation.py ./
COPY --chmod=0555 libreoffice /usr/local/bin/libreoffice
RUN install -d -m 0700 -o 65532 -g 65532 /scratch

FROM dependencies AS test
RUN --mount=type=cache,id=cert-board-sandbox-uv,target=/root/.cache/uv,sharing=locked \
    UV_NO_CACHE=0 UV_LINK_MODE=copy uv sync --locked --group test --no-install-project
COPY tests tests
USER 65532:65532
CMD ["/app/.venv/bin/python", "-m", "pytest", "-q"]

FROM dependencies AS runtime
USER 65532:65532
CMD ["/app/.venv/bin/uvicorn", "sandbox:app", "--host", "0.0.0.0", "--port", "28083", "--no-access-log", "--limit-concurrency", "8"]
