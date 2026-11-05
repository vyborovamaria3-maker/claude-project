FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential libpq-dev curl \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml README.md ./
COPY app ./app
COPY alembic ./alembic
COPY alembic.ini ./alembic.ini
COPY data ./data

RUN pip install --upgrade pip \
    && pip install -e . \
    && pip uninstall -y setuptools wheel jaraco.context \
    && python -c 'import importlib.metadata as m; blocked={"setuptools","wheel","jaraco.context"}; installed={d.metadata.get("Name","").lower() for d in m.distributions()}; remaining=sorted(blocked & installed); assert not remaining, remaining' \
    && groupadd --system potapoff \
    && useradd --system --gid potapoff --home-dir /app --shell /usr/sbin/nologin potapoff \
    && chown -R potapoff:potapoff /app

USER potapoff

EXPOSE 8000

CMD ["sh", "-c", "alembic upgrade heads && uvicorn app.main:app --host 0.0.0.0 --port 8000"]
