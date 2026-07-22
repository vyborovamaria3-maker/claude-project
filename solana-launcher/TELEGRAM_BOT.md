# Telegram Bot для управления AI агентами

Telegram бот интегрированный с solana-launcher для удаленного управления AI агентами, создания задач и мониторинга статуса.

## Возможности

- **Выбор AI агентов**: SWE-1.6, Claude Opus 4.7, Claude 3.5 Sonnet, Claude 3 Haiku, GPT-4, GPT-4 Turbo, GPT-3.5 Turbo, GPT-5.4, GPT-5.5, Claude 3 Opus, Claude 2.1
- **Создание задач**: Создавайте задачи для выполнения выбранным агентом
- **Мониторинг статуса**: Отслеживайте статус задач в реальном времени
- **Уведомления**: Получайте уведомления о завершении задач
- **Агент по умолчанию**: Установите предпочитаемого агента для быстрого создания задач

## Установка

1. **Получите токен бота**:
   - Откройте @BotFather в Telegram
   - Создайте нового бота командой `/newbot`
   - Скопируйте полученный токен

2. **Настройте переменные окружения**:
   ```bash
   # Добавьте в .env.local
   TELEGRAM_BOT_TOKEN=your_bot_token_from_botfather
   TELEGRAM_WEBHOOK_URL=https://your-app.railway.app/api/telegram/webhook
   ```

3. **Установите зависимости** (уже установлены):
   ```bash
   npm install telegraf ts-node
   ```

## Запуск

### Локальная разработка (polling)
```bash
npm run bot:dev
```

### Production (webhook)
```bash
npm run bot:start
```

## Команды бота

- `/start` - Начать работу с ботом
- `/agents` - Список доступных AI агентов
- `/new` - Создать новую задачу
- `/new_default` - Создать задачу с агентом по умолчанию
- `/set_default_agent` - Установить агента по умолчанию
- `/tasks` - Список ваших задач
- `/active` - Активные задачи
- `/status <task_id>` - Статус конкретной задачи
- `/cancel <task_id>` - Отменить задачу
- `/help` - Справка по командам

## API Endpoints

### Webhook
- `POST /api/telegram/webhook` - Telegram webhook endpoint
- `GET /api/telegram/webhook` - Health check

### Agents
- `GET /api/telegram/agents` - Список доступных агентов

## Структура проекта

```
telegram-bot/
├── index.ts              # Главный файл бота
├── handlers/             # Обработчики команд
│   ├── agents.ts         # Выбор агентов
│   ├── tasks.ts          # Управление задачами
│   └── status.ts         # Мониторинг статуса
├── middleware/           # Middleware для бота
│   ├── logging.ts        # Логирование
│   └── session.ts        # Управление сессиями
└── types.ts              # TypeScript типы

lib/telegram/
├── db.ts                 # База данных бота
└── agent-manager.ts      # Управление агентами

app/api/telegram/
├── webhook/route.ts      # Webhook для Telegram
└── agents/route.ts       # API для агентов

data/
└── telegram.db           # SQLite БД для бота
```

## База данных

Бот использует SQLite для хранения:
- Задач (tasks)
- Агентов (agents)
- Настроек пользователей (user_settings)

## Интеграция с AI агентами

В текущей реализации AI агенты работают в режиме placeholder. Для полноценной интеграции необходимо:

1. **SWE-1.6**: Интеграция с Cascade API
2. **Claude**: Добавить Anthropic API ключ в `.env.local`
3. **GPT**: Добавить OpenAI API ключ в `.env.local`

Пример переменных окружения:
```bash
ANTHROPIC_API_KEY=your_anthropic_api_key
OPENAI_API_KEY=your_openai_api_key
```

## Деплой

### Railway

1. Создайте новый проект на Railway
2. Подключите репозиторий
3. Добавьте переменные окружения
4. Разверните проект
5. Настройте webhook URL в @BotFather

### Render

1. Создайте новый Web Service на Render
2. Подключите репозиторий
3. Добавьте переменные окружения
4. Разверните проект
5. Настройте webhook URL в @BotFather

## Безопасность

- Валидация входных данных
- Логирование всех действий
- Ограничение на количество активных задач per user

## Troubleshooting

### Бот не отвечает
- Проверьте что `TELEGRAM_BOT_TOKEN` установлен корректно
- Убедитесь что бот запущен (`npm run bot:dev`)
- Проверьте логи на наличие ошибок

### Webhook не работает
- Убедитесь что `TELEGRAM_WEBHOOK_URL` указан правильно
- Проверьте что endpoint доступен извне
- Используйте `/api/telegram/webhook` для health check

### Ошибки базы данных
- Убедитесь что папка `data/` существует
- Проверьте права на запись в `data/telegram.db`
