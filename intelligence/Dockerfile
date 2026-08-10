FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app \
    POTAPOFF_INTELLIGENCE_DB=/var/lib/potapoff-intelligence/intelligence.sqlite3

WORKDIR /app

RUN groupadd --gid 10002 intelligence \
    && useradd --uid 10002 --gid intelligence --shell /usr/sbin/nologin intelligence

COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt \
    && rm -f /tmp/requirements.txt

COPY . /app/intelligence

RUN mkdir -p /var/lib/potapoff-intelligence \
    && chown -R intelligence:intelligence /app/intelligence /var/lib/potapoff-intelligence

USER intelligence

CMD ["python", "-m", "intelligence", "worker", "--poll-seconds", "2"]
