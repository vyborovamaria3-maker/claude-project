FROM denoland/deno:bin-2.9.5 AS deno

FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app \
    HOME=/tmp/potapoff-intelligence \
    XDG_CACHE_HOME=/tmp/potapoff-intelligence/cache \
    DENO_DIR=/tmp/potapoff-intelligence/deno \
    DENO_NO_UPDATE_CHECK=1 \
    DENO_NO_PROMPT=1 \
    POTAPOFF_INTELLIGENCE_DB=/var/lib/potapoff-intelligence/intelligence.sqlite3

WORKDIR /app

COPY --from=deno /deno /usr/local/bin/deno

RUN groupadd --gid 10002 intelligence \
    && useradd --uid 10002 --gid intelligence --shell /usr/sbin/nologin intelligence

COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt \
    && rm -f /tmp/requirements.txt \
    && yt-dlp --version \
    && deno --version

COPY . /app/intelligence

RUN mkdir -p /var/lib/potapoff-intelligence /tmp/potapoff-intelligence \
    && chown -R intelligence:intelligence /app/intelligence /var/lib/potapoff-intelligence /tmp/potapoff-intelligence

USER intelligence

CMD ["python", "-m", "intelligence", "worker", "--poll-seconds", "2"]
