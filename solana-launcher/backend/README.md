# POTAPoff Backend

FastAPI backend for the solana-launcher project.

## Stack
- FastAPI
- PostgreSQL
- SQLAlchemy 2.x + Alembic
- JWT auth
- SQLAdmin
- Redis
- Celery + RabbitMQ
- Prometheus metrics
- pytest
- Ruff + Mypy + pre-commit

## Local development
```bash
cp .env.example .env
pip install -e .[dev]
alembic upgrade head
uvicorn app.main:app --reload --port 8000
```

## Key endpoints
- `GET /health`
- `GET /ready`
- `POST /api/v1/auth/register`
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/login-json`
- `POST /api/v1/auth/phantom/nonce`
- `POST /api/v1/auth/phantom/verify`
- `POST /api/v1/auth/telegram/verify`
- `POST /api/v1/auth/link`
- `GET /api/v1/users/me`
- `POST /api/v1/tasks/demo-notification`
- `GET /metrics`

## Hybrid auth notes
- `users.id` is now a UUID primary key.
- Phantom login uses a nonce issued by `/api/v1/auth/phantom/nonce` and verified by `/api/v1/auth/phantom/verify`.
- Telegram Mini App login is verified server-side via `/api/v1/auth/telegram/verify`.
- Account linking is handled by `/api/v1/auth/link` while preserving existing email/password login.
- Run `alembic upgrade head` after pulling the latest schema changes.
