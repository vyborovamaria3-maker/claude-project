# AI Reply Guy Backend

[Быстрая 감독ировка]

## Быстрый старт

```bash
# Инициализация
cd backend
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate

# Установка
pip install -r requirements.txt

# Запуск
uvicorn app.main:app --reload --port 8000
```

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
