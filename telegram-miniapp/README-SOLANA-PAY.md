# Experimental Express/Prisma Solana Pay service

> Status: separate backend experiment; not the API used by the current
> POTAPoff Mini App page in solana-launcher. Do not treat this README as
> evidence of a deployed or production-ready payment service.

## Scope and files

- backend-new/: Express + TypeScript API, Prisma data layer and Helius webhook.
- backend-new/src/controllers/subscriptionController.ts: authenticated
  /api/subscription/* routes.
- backend-new/src/controllers/webhookController.ts: Helius webhook.
- backend-new/prisma/schema.prisma: User and Payment models.
- bot/: separate Node Telegram bot that opens a configured WebApp URL.
- frontend/: separate Vite prototype. Its current App.tsx calls the
  Next.js /api/miniapp/* routes, not this Express service. The older
  PayButton and useSubscription components are not wired into that App.

## Database

The checked-in Prisma schema explicitly selects SQLite:

    datasource db {
      provider = "sqlite"
      url      = env("DATABASE_URL")
    }

The matching .env.example uses DATABASE_URL=file:./dev.db. Do not describe
this service as PostgreSQL-backed. A production database migration/backup
design is not part of this experiment.

## Local setup

    cd telegram-miniapp/backend-new
    npm ci
    npx prisma generate
    npm run db:migrate
    npm run dev

Copy .env.example to .env first. Required values include DATABASE_URL,
MERCHANT_WALLET, HELIUS_API_KEY, HELIUS_WEBHOOK_SECRET (at least 32 characters)
and TELEGRAM_BOT_TOKEN. Production FRONTEND_URL must use HTTPS.

## API contract

Create a payment:

    POST /api/subscription/create
    Content-Type: application/json

    {
      "initData": "<raw Telegram.WebApp.initData>",
      "plan": "premium"
    }

The backend verifies Telegram initData server-side. A client-supplied
telegramId or username is not an authentication substitute.

Read subscription status:

    GET /api/subscription/status
    x-telegram-init-data: <raw Telegram.WebApp.initData>

There is no userId query parameter contract for this endpoint. Both routes
return Cache-Control: no-store where applicable.

## Payment verification

The Helius webhook is POST /webhook/helius. The request must include the
configured webhook secret in the Authorization header (Bearer form is
accepted). The secret is required by configuration and must be at least
32 characters; it is not optional.

A webhook notification alone does not activate a subscription. The handler
checks the payment reference/memo, destination, USDT mint and amount, then
calls the configured Solana RPC verification before confirming the payment.
Use a real Telegram initData only in an authorized test environment; do not
paste bot tokens, Helius keys, webhook secrets or wallet private keys into
issues or logs.

See HELIUS-SETUP.md for the experiment's endpoint and operator checklist.
