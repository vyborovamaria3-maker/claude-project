# POTAPoff FastAPI backend

Backend identity, subscription checks, Telegram vault and TG Invite ledger are served on port 8000. The separate admin-site session does not replace this backend.

## Быстрый старт

```bash
# Инициализация
cd backend
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate

# Установка из backend/ (requirements.txt не используется)
pip install -e '.[dev]'

# Проверка существующих настроек, без запуска и обращения к базе
python scripts/run_local.py --check --env-file /absolute/path/to/backend.env

# Запуск разрешён только после проверки настроек и отдельного решения о rollout
python scripts/run_local.py --env-file /absolute/path/to/backend.env
```

Из `solana-launcher/` доступны `npm run backend:check -- --env-file <path>` и `npm run backend:dev -- --env-file <path>`. По умолчанию используется `backend/.env`. Процесс слушает только `127.0.0.1:8000`; автоперезагрузка отключена.

`SECRET_KEY` обязателен. Файлы `.env.local` Next.js и `admin-site/.env` автоматически не читаются. Укажите существующий ключ подписи и явный `DATABASE_URL` существующей продуктовой базы: новый ключ инвалидирует JWT, а новая пустая база не содержит владельцев и TG Invite vault. Launcher не подставляет эти значения и не создаёт их. Окружение процесса имеет приоритет над выбранным файлом. Проверка `--check` не запускает lifespan, миграции, bootstrap администратора или Telegram runtime; успешная проверка конфигурации не доказывает доступность базы или авторизацию Telegram.

Шаблон актуальных параметров: `backend/.env.example`. Приведённые ниже legacy Reply Guy разделы не описывают текущую конфигурацию POTAPoff; используйте этот шаблон и актуальные схемы `app/api/v1`.

## Структура
- `app/main.py` - основной Entry Point
- `app/api/` - API endpoints
- `app/models/` - SQLAlchemy модели
- `app/schemas/` - Pydantic схемы
- `app/services/` - бизнес-логика
- `app/db/` - database session
- `app/auth/` - JWT Auth

## Ключевые API

### Accounts
- `POST /api/accounts` - Подключить X-аккаунт
- `GET /api/accounts` - Список аккаунтов
- `DELETE /api/accounts/{id}` - Удалить аккаунт

### Campaigns
- `POST /api/campaigns` - Создать кампанию
- `GET /api/campaigns` - Список кампаний
- `PATCH /api/campaigns/{id}` - Обновить кампанию

### Lore
- `POST /api/lore` - Создать персонажа
- `GET /api/lore` - Список персонажей
- `POST /api/lore/{id}/examples` - Добавить примеры RAG

### Proxies
- `POST /api/accounts/{id}/proxy` - Подключить прокси
- `GET /api/accounts/{id}/proxy/status` - Статус прокси

### Stats
- `GET /api/campaigns/{id}/stats` - Статистика
- `GET /api/accounts/{id}/stats` - Статистика аккаунта

### Alerts
- `GET /api/alerts` - Получение уведомлений

## .env конфигурация
```
DATABASE_URL=postgresql://user:pass@localhost:5432/ai_reply_guy
REDIS_URL=redis://localhost:6379/0
ENCRYPTION_KEY=32-byte-encryption-key-here
JWT_SECRET=your-jwt-secret
TELEGRAM_BOT_TOKEN=123:ABC
LLM_API_KEY=sk-...
LLM_PROVIDER=openai
```

## Безопасность
- Fernet шифрование cookies/proxy
- JWT аутентификация
- Rate limiting
- Изоляция аккаунтов (отдельный воркер на каждый)
- Telegram alerts при проблемах
- Просто без секретов в логах

## Структура воркера аккаунта
- Каждый аккаунт = отдельный процесс
- Цикл: check sources → filter → generate → post  
- Anti-detection (14 слоев)
- Rate limiting
- Sleep mode

## Telegram dataset integration

See [TELEGRAM_DATASETS.md](TELEGRAM_DATASETS.md) for public dataset sync, local TGDataset import, provenance, and operational limits.
