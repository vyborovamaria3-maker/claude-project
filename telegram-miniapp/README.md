# Telegram MiniApp workspace

This folder contains related prototypes and support tools, not one unified
backend. The current user-facing POTAPoff Mini App and its payment API live in
the solana-launcher workspace.

## Current Mini App flow

- Page: solana-launcher/app/miniapp/page.tsx
- Create checkout: solana-launcher/app/api/miniapp/create-invoice/route.ts
- Verify payment: solana-launcher/app/api/miniapp/verify-payment/route.ts
- Telegram bot: telegram-miniapp/bot (Node.js, polling)
- The bot opens the URL configured by WEBAPP_URL; for the current Next.js
  application it should end in /miniapp.

The current Next.js app is the API origin as well as the Mini App page. Start it
from the repository root:

    cd solana-launcher
    npm ci --legacy-peer-deps
    npm run dev

Configure solana-launcher/.env.local with the settings required by the
Mini App routes, including TELEGRAM_BOT_TOKEN and the selected subscription
storage/RPC settings. Do not copy production secrets into this repository.

Configure the bot:

    cd telegram-miniapp/bot
    npm ci

Copy bot/.env.example to .env and set:

- BOT_TOKEN — token issued by BotFather;
- WEBAPP_URL — the public HTTPS URL of the current app, ending in /miniapp.

Then run npm run dev from telegram-miniapp/bot. The bot does not host the
Mini App or payment API.

## Local Windows helpers

- start-all.bat starts the Next.js application and the Node Telegram bot
  using repository-relative paths. It expects dependencies and environment
  files to be prepared first.
- start-tunnel.bat and start-tunnel.ps1 expose the Next.js app on port
  3000, where the actual /miniapp page and API routes live. They no longer
  tunnel the Vite preview on port 5173.
- For a temporary tunnel, copy its HTTPS URL and set
  WEBAPP_URL=https://<tunnel-host>/miniapp in telegram-miniapp/bot/.env,
  then restart the bot.

A tunnel makes the development app publicly reachable. Use test accounts and
non-production data only; do not expose a production database or secrets through
a development server.

## Other code in this folder — do not conflate it with the current flow

### Vite frontend prototype

frontend/ is a separate Vite/React prototype. Its current App.tsx calls
/api/miniapp/* on the same origin, but the Vite config has no proxy to the
Next.js API. It is not the canonical deployed page and should not be deployed
as a standalone frontend without an explicitly designed same-origin/API
routing setup.

The PayButton and useSubscription components are not imported by the
current frontend/src/App.tsx.

### Express/Prisma experiment

backend-new/ is a separate Express service with /api/subscription/*
routes and a Helius webhook. Its Prisma schema uses SQLite
(provider = "sqlite", DATABASE_URL=file:./dev.db), not PostgreSQL.
It is not the API used by the current solana-launcher Mini App flow or by
the Vite App.tsx. See README-SOLANA-PAY.md and HELIUS-SETUP.md before working
on that experiment.

The previous telegram-miniapp/backend/ Python/aiogram path is absent from
the current repository tree. Do not use old commands that reference it.
