# AI Gateway

Универсальный клиент для подключённых AI API, совместимых с OpenAI Chat Completions и Embeddings. Локальные LLM не запускаются; модель и провайдер выбираются конфигурацией. Gateway не выбирает и не включает платного провайдера по умолчанию.

## Безопасная конфигурация

Включение только явное:

```env
AI_GATEWAY_ENABLED=true
AI_DEFAULT_PROVIDER=primary
AI_PROVIDERS_JSON=[{"id":"primary","baseUrl":"https://api.example.com/v1","apiKeyEnv":"PRIMARY_AI_API_KEY","chatModel":"your-chat-model","embeddingModel":"your-embedding-model","timeoutMs":20000,"requestsPerMinute":30,"maxConcurrent":2,"maxInputChars":24000,"maxOutputTokens":2000}]
PRIMARY_AI_API_KEY=<secret-from-your-secret-manager>
```

`AI_PROVIDERS_JSON` содержит только имя переменной с секретом, не сам ключ. Не добавляйте реальные ключи в JSON, исходники, логи или миграции. У каждого провайдера должен быть HTTPS endpoint; локальные HTTP LLM endpoint намеренно отклоняются. Можно настроить несколько провайдеров, а `AI_DEFAULT_PROVIDER` выбирает основной. Конкретный URL и названия моделей нужно взять из подключённого провайдера, не из этого примера.

## Ограничения и наблюдаемость

- Таймауты, лимиты размера входа/выхода, ограничение параллельных запросов и локальный лимит запросов в минуту.
- Ограниченные повторы только для сетевых ошибок, HTTP 429 и 5xx. Ошибки авторизации не повторяются.
- Метрики содержат провайдера, задачу, задержку, usage и оценочную стоимость — не prompt, response или API key.
- Оценка стоимости доступна, если заданы `inputCostPer1kUsd` и `outputCostPer1kUsd`; опциональный `maxEstimatedCostUsd` является лимитом одного процесса, а не заменой лимитов биллинга у провайдера.
- Ответ embeddings проверяется на конечные числа и ожидаемую размерность. Для Feature Store V3 требуется 1024 измерения.
- Gateway не отправляет запросы, пока его явно не создадут и не вызовут. В shared Intelligence модель дополнительно должна быть зарегистрирована в `model_registry` и иметь статус `active`.

Поддерживаются OpenAI-совместимые API. Нативные SDK/форматы конкретных провайдеров требуют отдельного адаптера.
