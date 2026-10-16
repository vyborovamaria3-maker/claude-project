# Чистка неиспользуемого agent scaffold (15 файлов)

## Что удалено из исходников

- `agent-collaboration.ts`
- `agent-coordinator.ts`
- `agent-events.ts`
- `agent-feedback-loop.ts`
- `agent-load-balancer.ts`
- `agent-memory.ts`
- `agent-message-bus.ts`
- `agent-registry.ts`
- `agent-runtime.ts`
- `agent-scheduler.ts`
- `agent-worker.ts`
- `swarm-coordinator.ts`
- `specialized-agents.ts`
- `task-executor.ts`
- `task-orchestrator.ts`

### Обоснование

Эти исходники — небольшие изолированные реализации абстрактных
агентов/планировщиков в `lib/intelligence/`, не используемые активными
точками входа в отчёте Knip из независимого PR #74.

Перед созданием PR были изучены их статические импорты: зависимости
между удаляемыми файлами (`agent-coordinator` → `agent-registry`,
`specialized-agents` → `agent-registry`,
`agent-scheduler` → `agent-runtime`,
`task-orchestrator` → `agent-core`) потребовали сохранить исходный
`agent-core.ts`: им также пользуется остающийся `analysis-planner.ts`.

**Ограничение проверки**: Knip не гарантирует обнаружение загрузки
по динамическим строкам или незафиксированных внешних импортёров.
Проверить отсутствие сторонних пользователей этих API перед merge.

### Что не менялось

Очередь, Playwright/XActions, миграции, схемы PostgreSQL,
разделение Reply Guy, `src/intelligence/` и вся основная аналитика.
Никаких операций с сохранёнными данными не производится.

История Git сохраняет удалённые исходники, восстановление возможно
через revert PR без необратимого преобразования данных.

### Требования к объединению

- Typecheck / lint / build и вся тестовая матрица X Collector — зелёные;
- подтверждено отсутствие динамических загрузчиков этих имён;
- замечания пользователей внутренних CLI/внешних интеграций проверены.

Удаление выполнено **в отдельном черновом PR**, не в накопленном #69.
