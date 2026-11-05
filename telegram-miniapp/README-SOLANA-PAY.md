# Telegram MiniApp + Solana Pay — prototype notes

Этот документ описывает prototype flow оплаты через Solana Pay. Он не является подтверждением production deployment, фактического приёма платежей или того, что подписки уже централизованы в этом приложении.

## Фактическая структура

```text
telegram-miniapp/
├── frontend/       # Vite + React + Telegram WebApp SDK
├── bot/            # Node.js + node-telegram-bot-api
└── backend-new/    # Node.js + Express + Prisma
```

Каталога `backend/` с Python/aiogram в текущей ревизии нет. Старые инструкции запуска Python bot удалены как не соответствующие исходникам.

## Storage — важно

`backend-new/prisma/schema.prisma` задаёт:

```prisma
datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}
```

Актуальный пример в `backend-new/.env.example`:

```env
DATABASE_URL=file:./dev.db
```

Поэтому прежний пример `postgresql://...` в этом документе был неверен для текущей схемы. PostgreSQL нельзя считать текущим backend storage без отдельного изменения Prisma provider, миграции и restore-tested перехода.

## Подпроект backend-new

Точка входа: `backend-new/src/index.ts`.

В коде объявлены:
- `GET /health`;
- `POST /api/subscription/create`;
- `GET /api/subscription/status`;
- `POST /webhook/helius`;
- `GET /webhook/helius/health`.

Backend config находится в `backend-new/src/config`; Prisma models — User и Payment. Пример env — `backend-new/.env.example`.

## Frontend и bot

Frontend:
- каталог `frontend/`;
- Vite + React;
- API base URL через `VITE_API_URL`.

Bot:
- каталог `bot/`;
- Node.js `node-telegram-bot-api`;
- ожидает `BOT_TOKEN` и `WEBAPP_URL`;
- polling runtime.

Эти части — отдельные процессы. Их наличие в монорепозитории не доказывает, что они развёрнуты вместе.

## Ограничения

1. 1000 USDT / 1 year — параметр, указанный в prototype UI/боте; не утверждение о реальном тарифе.
2. Не считать webhook/transaction confirmation live-verified без отдельного теста с Solana RPC и Helius.
3. Не считать подписку в этой SQLite базe канонической для Solana Launcher или SolSub.
4. До production use требуются security review, payment replay/idempotency review, webhook signature verification, DB migration strategy, backup/restore и операторский runbook.
5. В архитектурном аудите 2026-11-01 live deployment, live wallet, реальные webhook credentials и платежи не проверялись.

## Связанные документы

- [Telegram MiniApp inventory](README.md)
- [Solana Subscription Service](../solana-subscription-service/README.md)
