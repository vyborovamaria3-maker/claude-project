FROM python:3.12-slim AS builder

ENV PIP_NO_CACHE_DIR=1

WORKDIR /build

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential libpq-dev \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml README.md ./
COPY app ./app

# Build wheels in an isolated stage so compilers and PEP 517 build tools
# never enter the production runtime image.
RUN pip install --upgrade pip \
    && pip wheel --wheel-dir=/wheels .

RUN pip install --no-index --find-links=/wheels --prefix=/install potapoff-backend


FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends libpq5 curl \
    && for package in python3-setuptools python3-pkg-resources; do \
         if dpkg-query -W -f='${db:Status-Status}' "$package" 2>/dev/null | grep -qx installed; then \
           apt-get purge -y "$package"; \
         fi; \
       done \
    && rm -rf /var/lib/apt/lists/*

# Only the installed application and runtime dependencies cross the stage
# boundary. Build-essential, setuptools, wheel and build caches stay behind.
COPY --from=builder /install/ /usr/local/
COPY alembic ./alembic
COPY alembic.ini ./alembic.ini
COPY data ./data

RUN python -m pip uninstall -y setuptools wheel \
    && python -c 'import importlib.metadata as m; blocked={"setuptools","wheel","jaraco.context"}; installed={d.metadata.get("Name","").lower() for d in m.distributions()}; remaining=sorted(blocked & installed); assert not remaining, remaining' \
    && groupadd --system potapoff \
    && useradd --system --gid potapoff --home-dir /app --shell /usr/sbin/nologin potapoff \
    && chown -R potapoff:potapoff /app

USER potapoff

EXPOSE 8000

CMD ["sh", "-c", "alembic upgrade heads && uvicorn app.main:app --host 0.0.0.0 --port 8000"]
