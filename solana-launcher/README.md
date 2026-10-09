# 🤖 AI Reply Guy - ПОЛНАЯ СИСТЕМА АВТОМАТИЧЕСКИХ ОТВЕТОВ В X (TWITTER)

**2FA-ученик (2FA) - Для приложения GSD: Все, что нужно для запуска MVP**

## 📋 Обзор

Полноценная система автоматических ответов в X (Twitter) с персонажем и RAG-поиском. 
Управление через Telegram-бота или веб-интерфейс.

### Ключевые возможности

- 🎭 **Персонаж (Lore)** - Пишет от имени вашего персонажа
- 🔄 **RAG-поиск** - Поиск похожих примеров для попадания в стиль
- 🤖 **LLM интеграция** - Поддержка OpenAI, Anthropic и локальных моделей
- 🛡️ **Anti-detection** - 14 слоев маскировки под живого пользователя
- 📊 **Прокси** - Поддержка HTTP/HTTPS/SOCKS4/SOCKS5 с геолокацией
- 🔒 **Безопасность** - Fernet шифрование, JWT, изоляция аккаунтов
- 💰 **Rate limiting** - Управление темпом ответов
- 📈 **Статистика** - Мониторинг работы в реальном времени

## 🚀 Быстрый старт

### 1. Установка (через docker-compose)

```bash
# Клонируйте репозиторий
git clone https://github.com/vyborovamaria3/ai-reply-guy.git
cd ai-reply-guy

# Запустите setup
chmod +x ./deploy.sh
./deploy.sh
```

### 2. Настройка переменных окружения

Отредактируйте `.env`:

```bash
# Сгенерированные ключи
ENCRYPTION_KEY=<32-байтный ключ>
JWT_SECRET=<сложный JWT secret>

# Telegram Bot
TELEGRAM_BOT_TOKEN=ваш-токен-от-@BotFather

# LLM (опционально, можно локально)
LLM_API_KEY=sk-kлюч-openai
LLM_PROVIDER=openai

# База данных
POSTGRES_PASSWORD=secure_password_123
```

### 3. Проверка работы

```bash
# Пропишите Docker Compose
docker-compose ps

# Должно быть 6 контейнеров:
# ai-reply-guy-db (PostgreSQL)
# ai-reply-guy-redis (Redis) 
# ai-reply-guy-rabbitmq (RabbitMQ)
# ai-reply-guy-backend (API)
# ai-reply-guy-telegram (Telegram бот)
# ai-reply-guy-frontend (Web UI)
```

### 4. Доступ к системам

- **Backend API**: http://localhost:8000
- **Web Interface**: http://localhost:3000
- **Telegram Bot**: @ваш_bot_username
- **RabbitMQ Management**: http://localhost:15672 (login: ai_reply_guy, password: secure_password_123)

## 📁 Структура проекта

```
ai-reply-guy/
├── backend/           # FastAPI backend
│   ├── app/
│   │   ├── api/       # API endpoints
│   │   ├── models/    # SQLAlchemy models
│   │   ├── schemas/   # Pydantic schemas
│   │   ├── services/  # Business logic
│   │   └── db/        # Database session
│   ├── Dockerfile
│   └── requirements.txt
├── worker/            # Service workers
│   ├── reply_worker.py
│   └── Dockerfile
├── telegram-bot/      # Telegram bot UI
│   ├── app/
│   │   ├── bot.py
│   │   └── templates/
│   └── Dockerfile
├── frontend/          # Next.js web interface
│   ├── app/
│   ├── lib/
│   └── Dockerfile
├── docker-compose.yaml
└── deploy.sh
```

## 🎯 Основные APIendpoints

### Accounts
- `POST /api/accounts` - Подключить X-аккаунт
- `GET /api/accounts` - Список аккаунтов
- `DELETE /api/accounts/{id}` - Удалить аккаунт

### Campaigns
- `POST /api/campaigns` - Создать кампанию
- `GET /api/campaigns` - Список кампаний
- `PATCH /api/campaigns/{id}` - Обновить кампанию

### Lore (Персонаж)
- `POST /api/lore` - Создать персонажа
- `GET /api/lore` - Список персонажей
- `POST /api/lore/{id}/examples` - Добавить пример RAG

### Proxies
- `POST /api/accounts/{id}/proxy` - Подключить прокси
- `GET /api/accounts/{id}/proxy/status` - Статус прокси

### Stats & Alerts
- `GET /api/campaigns/{id}/stats` - Статистика кампании
- `GET /api/accounts/{id}/stats` - Статистика аккаунта
- `GET /api/alerts` - Получение уведомлений

## 🛠️ Настройка

### База данных
```sql
-- Создать базу данных
CREATE DATABASE ai_reply_guy;

-- Apply migrations
psql -U ai_reply_guy -d ai_reply_guy -f migrations/012_ai_reply_guy.sql
```

### Redis & RabbitMQ
```bash
# Redis
docker-compose run --rm redis redis-cli ping

# RabbitMQ
docker-compose ps | grep rabbitmq
```

### Worker Configuration
Каждый X-аккаунт запускает отдельный worker process через RabbitMQ queue.

## 🔐 Безопасность

- **Fernet шифрование** (AES-CBC + HMAC-SHA256) для cookies и прокси
- **JWT аутентификация** (HS256) между бэкендом и ботами
- **Изоляция процессов** - один воркер на каждый аккаунт
- **Алерты в Telegram** при проблемах
- **Регулярное резервное копирование** базы данных
- **Ограничение скорости** через Redis

## 🚨 Алерты

### Уведомления в Telegram

- `PROXY_DEAD` - Прокси умер
- `COOKIES_EXPIRED` - Cookies истекли
- `SPAM_BLOCK` - Блок спам-блока
- `WORKER_CRASH` - Воркер упал
- `GEAR_LIMIT_REACHED` - Достигнут лимит ответов

### Интеграция с Telegram Bot

```bash
# Получить alerts
curl http://localhost:8080/api/alerts

# Развернуть зависимости
docker-compose run --rm backend python -c "
from app.services.alerts import send_alert
send_alert(user_id, 'ПРОВЕРКА', 'Все хорошо')
"
```

## 📊 Мониторинг

### Prometheus + Grafana (опционально)

```yaml
# docker-compose.override.yml
services:
  prometheus:
    image: prom/prometheus:latest
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
  
  grafana:
    image: grafana/grafana:latest
    ports:
      - "3001:3000"
```

### Metrics
- Количество ответов в час
- Status worker (active/paused)
- Количество успешных запросов
- Rate limiting status

## 🧪 Тесты

```bash
# Backend tests
cd backend
pytest tests/

# Frontend tests
cd frontend
npm test

# Integration tests
pytest tests/integration/
```

## 📚 Документация

- [API Documentation](http://localhost:8000/docs)
- [Swagger UI](http://localhost:8000/redoc)
- [Wiki](https://github.com/vyborovamaria3/ai-reply-guy/wiki)

## 🔄 Обновление

```bash
# Pull last code
git pull origin main

# Build and run
docker-compose down
docker-compose build --no-cache
docker-compose up -d

# Check logs
docker-compose logs -f backend
docker-compose logs -f worker
```

## 🛠️ Troubleshooting

### Backend не запускается
```bash
# Check database connection
docker-compose exec postgres pg_isready -U ai_reply_guy

# Check Redis connection
docker-compose exec redis redis-cli ping

# Check RabbitMQ
docker-compose exec rabbitmq rabbitmqctl status
```

### Воркеры не работают
```bash
# Check RabbitMQ queue
docker-compose exec rabbitmq rabbitmqctl list_queues

# Watch worker logs
docker-compose logs -f worker | grep "Worker started"
```

### Хранение большого количества данных
```bash
# Оптимизация PostgreSQL
docker-compose exec postgres psql -U ai_reply_guy -d ai_reply_guy -c "
VACUUM ANALYZE campaign_filters;
"
```

## 🎯 Roadmap

- [x] PostgreSQL schema
- [x] Backend FastAPI
- [x] Worker service
- [x] Telegram bot
- [x] Web interface
- [x] Docker deployment
- [ ] GDPR compliance
- [ ] Additional LLM providers
- [ ] Advanced threat moderation
- [ ] Multi-language support
- [ ] Mobile app

## 📄 License

MIT License - см. LICENSE file

## 🤝 Contributing

1. Fork repository
2. Create feature branch
3. commit changes
4. Push to branch
5. Open Pull Request

---

**AI Reply Guy** - Автоматизируйте ответы в X (Twitter) с профессиональным качеством! 🚀