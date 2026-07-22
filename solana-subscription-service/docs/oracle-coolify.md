# Oracle Cloud + Coolify deployment

This document describes the recommended free test deployment path for `solana-subscription-service`.

## Stack

- Oracle Cloud Always Free Ubuntu VM
- Docker Engine
- Coolify
- `docker-compose.prod.yml`
- PostgreSQL and Redis on the same VM

## Why this target

- full Docker control
- one server is enough for API, web, bot, Postgres, and Redis
- no sleep policy from a platform-as-a-service free tier
- simple path from test deployment to long-lived staging

## 1. Create the VM

Use an Oracle Always Free Ubuntu VM in your home region.

Open:

- `22` for SSH
- `80` for HTTP
- `443` for HTTPS

## 2. Install Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker
docker --version
```

## 3. Install Coolify

```bash
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash
```

Then open:

```text
http://YOUR_SERVER_IP:8000
```

Finish the first-run setup in Coolify.

## 4. Repository setup in Coolify

Point Coolify at this repository and set:

- base directory: `solana-subscription-service`
- deployment type: `Docker Compose`
- compose file: `docker-compose.prod.yml`

## 5. Required environment variables

Start from `.env.example`, then set at least:

- `POSTGRES_PASSWORD`
- `JWT_ACCESS_SECRET`
- `JWT_REFRESH_SECRET`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_BOT_USERNAME`
- `TELEGRAM_WEBHOOK_SECRET`
- `WEB_ORIGIN`
- `API_PUBLIC_URL`
- `WEB_PUBLIC_URL`
- `COOKIE_SECURE=true`
- `RPC_ENDPOINT`
- `TREASURY_WALLET`
- `TREASURY_USDC_TOKEN_ACCOUNT`
- `NEXT_PUBLIC_API_URL`
- `NEXT_PUBLIC_WEB_URL`
- `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME`
- `NEXT_PUBLIC_SOLANA_CLUSTER`
- `NEXT_PUBLIC_RPC_ENDPOINT`
- `NEXT_PUBLIC_TREASURY_WALLET`

## 6. Routing

In Coolify, expose:

- `web` on your public app domain
- `api` on a separate API subdomain

Typical example:

- `https://solsub.example.com` -> `web:3000`
- `https://api.solsub.example.com` -> `api:4000`

## 7. Deployment command behavior

The API container runs:

```text
npm run prisma:deploy -w @solsub/api && npm run prisma:seed -w @solsub/api && npm run start -w @solsub/api
```

That means migrations and seed data are applied during deployment before the API starts.

## 8. Recommended test checklist

- web app opens over HTTPS
- API health endpoint responds
- database migrations complete
- bot starts without crashing
- Redis is healthy
- Telegram login works
- wallet challenge flow works

## 9. Notes

- This setup is aimed at testing and staging, not high-availability production.
- If you later want a managed database, replace the internal Postgres service with Neon or Supabase and remove `postgres` from the compose file.
