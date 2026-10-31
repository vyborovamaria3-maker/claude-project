# Helius setup — Express/Prisma experiment only

This guide applies only to telegram-miniapp/backend-new. It does not configure
the current POTAPoff Mini App routes in solana-launcher.

## Required configuration

Copy backend-new/.env.example to backend-new/.env and configure:

- DATABASE_URL=file:./dev.db for the checked-in SQLite Prisma schema;
- SOLANA_RPC_URL;
- USDT_MINT;
- MERCHANT_WALLET;
- HELIUS_API_KEY;
- HELIUS_WEBHOOK_SECRET — required, random and at least 32 characters;
- FRONTEND_URL;
- TELEGRAM_BOT_TOKEN.

Do not substitute a PostgreSQL URL without first changing and reviewing the
Prisma schema, migrations, tests and deployment design.

## Webhook

Configure Helius to send notifications to:

    https://<your-backend-host>/webhook/helius

Use the configured merchant wallet as the watched account. The service expects
the webhook secret in the Authorization header (Bearer form is accepted).
Keep the secret private.

## Authenticated API contract

Payment creation requires Telegram's raw signed initData:

    curl -X POST http://localhost:3001/api/subscription/create \
      -H "Content-Type: application/json" \
      -d '{"initData":"<raw Telegram.WebApp.initData>","plan":"premium"}'

Subscription status uses the same signed Telegram data in a header:

    curl http://localhost:3001/api/subscription/status \
      -H "x-telegram-init-data: <raw Telegram.WebApp.initData>"

Do not use the old examples that submit a bare telegramId or a
userId query parameter; those do not match the current controller contract.

## Local checks

    cd telegram-miniapp/backend-new
    npm ci
    npx prisma generate
    npm run build
    npm run dev

- Health: GET /health
- Webhook health: GET /webhook/helius/health
- Create payment: POST /api/subscription/create
- Check status: GET /api/subscription/status

A mock webhook payload is not proof of a finalized payment. The handler performs
a separate RPC verification before confirming a subscription. Keep any test
wallet, provider quota and Telegram account within an explicitly approved test
environment.
