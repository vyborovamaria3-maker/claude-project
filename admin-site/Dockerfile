FROM node:22-bookworm-slim AS collector-ui
WORKDIR /src
COPY solana-launcher/package.json solana-launcher/package-lock.json ./solana-launcher/
COPY solana-launcher/scripts/bigint-safe-package ./solana-launcher/scripts/bigint-safe-package
COPY solana-launcher/scripts/xlsx-safe-package ./solana-launcher/scripts/xlsx-safe-package
RUN cd solana-launcher && npm ci --legacy-peer-deps --ignore-scripts --no-audit --no-fund
COPY solana-launcher ./solana-launcher
COPY admin-site/ui ./admin-site/ui
RUN node solana-launcher/node_modules/vite/bin/vite.js build --configLoader native --config admin-site/ui/vite.config.mjs

FROM python:3.12-slim AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 DEBIAN_FRONTEND=noninteractive
WORKDIR /app
RUN apt-get update \
    && apt-get upgrade -y \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 admin \
    && useradd --uid 10001 --gid admin --shell /usr/sbin/nologin admin
COPY admin-site/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY admin-site/app ./app
COPY admin-site/scripts ./scripts
COPY --from=collector-ui /src/admin-site/app/static/collector-workspaces ./app/static/collector-workspaces
RUN mkdir -p /var/lib/potapoff-admin && chown -R admin:admin /app /var/lib/potapoff-admin
USER admin
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/api/ready', timeout=3).read()"
CMD ["python", "scripts/run_admin.py"]
