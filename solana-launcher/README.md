# POTAPoff

Futuristic Solana token launch & trading dashboard.

## Stack
- Next.js 14 (App Router) + TypeScript
- Tailwind CSS
- Recharts
- lucide-react

## Backend stack
- FastAPI
- PostgreSQL + SQLAlchemy + Alembic
- JWT auth
- SQLAdmin
- Redis + Celery + RabbitMQ
- Nginx + Prometheus
- pytest + Ruff + Mypy + pre-commit
- Docker Compose

## Run
```bash
npm install
npm run dev
```
Open http://localhost:3000

## Full-stack development
```bash
docker compose up --build
```

- Compose uses `backend/.env.example` by default.
- Copy it to `backend/.env` only for standalone backend runs outside Docker Compose.

- Frontend: http://localhost:3000
- Backend API: http://localhost:8000
- Admin: http://localhost:8000/admin
- Metrics: http://localhost:8000/metrics

## Структура страниц
- `/` — Dashboard
- `/token-launch` — создание токена
- `/bundles` — Jito bundle трейдинг
- `/wallets` — менеджер кошельков
- `/bump-bot` — bump bot
- `/settings` — настройки

## Data tags
Все динамические данные и контейнеры размечены атрибутом `data-tag`,
например `data-tag="stats.bundles_launched"`. Заменяйте mock в
`lib/mockData.ts` / `lib/api.ts` на реальные эндпоинты по этим тегам.
