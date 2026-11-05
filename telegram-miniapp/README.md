# Telegram MiniApp — demo / legacy subproject

Этот каталог содержит несколько самостоятельных подпроектов. Не путать его с `solana-subscription-service` или MiniApp внутри Solana Launcher.

## Фактическая структура

| Каталог | Технологии | Назначение |
|---|---|---|
| `frontend/` | Vite, React 18, TypeScript, Telegram WebApp SDK | Отдельный web frontend |
| `bot/` | Node.js, TypeScript, `node-telegram-bot-api` | Telegram bot, который отправляет ссылку на MiniApp |
| `backend-new/` | Node.js, Express, Prisma | Отдельный API для payment/subscription prototype; Prisma schema сейчас использует SQLite |

**Важно:** на текущей ревизии каталога `backend/` нет. Старые инструкции про Python/aiogram и `backend/bot.py` не соответствуют дереву исходников. Текущий Node bot расположен в `bot/`.

## Локальный запуск

### Frontend

```bash
cd frontend
npm ci
npm run dev
```

### Telegram bot

```bash
cd bot
npm ci
```

В окружении нужны `BOT_TOKEN` и `WEBAPP_URL`. Код использует polling через `node-telegram-bot-api`.

```bash
npm run dev
```

### Backend API

```bash
cd backend-new
npm ci
npx prisma generate
npx prisma migrate dev
npm run dev
```

Фактический datasource находится в `backend-new/prisma/schema.prisma` и имеет provider `sqlite`. Пример конфигурации — `backend-new/.env.example`, где `DATABASE_URL=file:./dev.db`.

Не использовать PostgreSQL URL из старых копий документации без отдельной миграции Prisma datasource и проверенного migration plan.

## Статус и ограничения

- Это отдельный demo/legacy subproject, а не подтверждённая production subscription platform.
- Старый README описывал mock/demo оплату и mock watchlist/swap.
- Наличие Express handlers и Prisma models не доказывает, что Telegram bot, frontend, webhook и реальные платежи запущены.
- Не использовать этот проект как канонический источник подписок, пока не принято и не выполнено отдельное решение о миграции на Solana Subscription Service.
- Секреты, bot token, RPC key и webhook secret не добавлять в Git.
- Реальные платежи и live webhooks не проверялись в рамках архитектурного аудита 2026-11-01.

Для отдельной схемы Solana Pay см. [README-SOLANA-PAY.md](README-SOLANA-PAY.md); он также является описанием prototype и не подтверждает production deployment.
