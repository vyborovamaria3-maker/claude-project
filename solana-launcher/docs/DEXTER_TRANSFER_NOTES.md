# Заметки по переносу фич Dexter

Этот документ сопоставляет самые полезные идеи из `Dexter-main` с текущим кодом `solana-launcher` и ранжирует их по ценности для переноса.

## 1) В чём Dexter особенно силён

Dexter — это Solana-тул для торговли, ориентированный на создателей токенов, с тремя заметными слоями:

- **Слой интерактивной работы**
  - curses/TUI-меню для config, run, create, manage, help
  - прямое редактирование `.env` и onboarding
  - жёсткие safety-подтверждения перед live/mainnet-действиями

- **Слой принятия решений**
  - профили оценки creator’ов (`aggressive`, `balanced`, `conservative`)
  - оценка входа/выхода с явными причинами блокировки
  - backtesting по историческим записям

- **Слой хранения и операционного управления**
  - нормализованные snapshot’ы на PostgreSQL
  - replay/export проанализированных сессий
  - operator controls: pause, whitelist, blacklist, watchlist, force-sell

## 2) Что уже покрывает `solana-launcher`

В текущем приложении уже есть сильные пересечения по нескольким направлениям:

- **Пайплайн анализа трейдов**
  - `app/api/trade/analyze/route.ts`
  - `lib/trade/trade-cache.ts`
  - `lib/trade/merged-trades.ts`
  - `lib/trade/classify.ts`
  - `lib/trade/db.ts`

- **Анализ creator/dev и форензика**
  - `app/api/trade/dev-forensics/route.ts`
  - `components/trade/DevForensicsPanel.tsx`
  - `components/chart/tabs/DevForensicsTab.tsx`

- **Анализ X/Twitter с выбором стратегии**
  - `lib/trade/twitter-scraper.ts`
  - `app/api/trade/dev-twitter/route.ts`
  - `app/x-analysis/page.tsx`

- **UX генерации и управления кошельками**
  - `lib/walletStore.ts`
  - `app/cto-wallets/page.tsx`

- **CSV-export и chart tooling**
  - `lib/chart/csvExport.ts`
  - `components/chart/CSVExportButton.tsx`
  - `docs/CHART_ARCHITECTURE.md`

## 3) Лучшие кандидаты для переноса

### A. Добавить health check / doctor-подобный экран

**Почему это важно**
- Команда `doctor` в Dexter — очень практичный операторский инструмент.
- Она проверяет env, RPC, wallet, директории и БД до старта торговли.

**Лучшее место в `solana-launcher`**
- `app/settings` или новая diagnostics-page.
- Можно переиспользовать существующие проверки из trade / bundler / wallet-утилит.

**Что показывать**
- карточки pass / warn / fail
- статус безопасности mainnet
- доступность RPC
- наличие и готовность кошелька
- готовность cache/database

### B. Перенести явные профили оценки creator’ов

**Почему это важно**
- Модель оценки Dexter читаемая и удобная для оператора.
- У неё есть чёткие пороги, веса и причины блокировки.

**Лучшее место в `solana-launcher`**
- `lib/trade/classify.ts`
- `app/api/trade/analyze/route.ts`
- будущая UI-панель в trade analysis / dev forensics

**Что показывать**
- именованные strategy profiles
- веса по фичам
- объяснимые решения по входу/выходу
- labels confidence / trust level

### C. Добавить replay/export для analysis sessions

**Почему это важно**
- Dexter умеет экспортировать и воспроизводить нормализованные сессии — это полезно для отладки и исследования.
- `solana-launcher` уже хранит аналитические данные в SQLite, значит база для этого уже есть.

**Лучшее место в `solana-launcher`**
- расширить `lib/trade/db.ts`
- добавить route для export или action для download
- показать в UI replayable JSON snapshots

**Что показывать**
- JSON export результатов анализа
- CSV export токенов / кошельков / сессий
- replay-view прошлых анализов

### D. Добавить операторское состояние управления

**Почему это важно**
- Pause / whitelist / blacklist / watchlist у Dexter простые, но очень полезные.
- Это уже не просто аналитика, а полноценный операционный workflow.

**Лучшее место в `solana-launcher`**
- `lib/trade/db.ts` или отдельный state store
- settings/admin page
- flows для wallet / creator tagging

**Что показывать**
- pause/unpause data feeds
- creator allow/deny lists
- watchlist отслеживаемых mint’ов
- ручные force-sell flags или notes

### E. Сделать полноэкранный конфиг для торговой безопасности

**Почему это важно**
- Конфигурационные страницы Dexter уменьшают ошибки за счёт группировки настроек по смыслу.
- Это особенно полезно, когда в проекте уже много переключателей.

**Лучшее место в `solana-launcher`**
- `app/settings`
- отдельная вкладка “Trading Safety”
- группировка настроек для launch, bundler, analysis, alerts

**Что показывать**
- вкладки runtime / safety / risk / alerts
- live status индикаторы для критичных настроек
- предупреждения перед рискованными действиями

## 4) Что лучше не копировать напрямую, а переработать

Некоторые идеи Dexter полезны концептуально, но не подходят для прямого копирования 1:1:

- **Curses TUI**
  - `solana-launcher` — браузерное приложение, значит аналог должен быть web admin/diagnostics surface.

- **Прямой PostgreSQL-моделью**
  - сейчас `solana-launcher` сильно опирается на SQLite для быстрого локального состояния.
  - PostgreSQL имеет смысл только если нужен cross-session, multi-process или remote persistence.

- **Однокомандный runtime launcher**
  - CLI-runner Dexter — хороший паттерн, но в этом приложении это лучше превратить в UI actions или API routes.

## 5) Рекомендуемый порядок переноса

1. **Doctor / diagnostics UI**
   - самый быстрый выигрыш, низкий риск, высокая ценность.

2. **Creator scoring profiles**
   - даст анализу более ясную структуру.

3. **Export / replay surfaces**
   - отлично для отладки и provenance.

4. **Operator control state**
   - полезно, но лучше после появления safety/diagnostic основы.

5. **Config UX cleanup**
   - стоит делать, когда критичные controls уже определены.

## 6) Практический путь внедрения

- **Фаза 1**
  - переиспользовать существующие analysis data и сделать diagnostics view.
  - показать RPC, DB, cache, wallet и feature readiness.

- **Фаза 2**
  - добавить profile-based scoring objects в `lib/trade/classify.ts`.
  - вывести thresholds и blocking reasons в UI.

- **Фаза 3**
  - добавить export/replay endpoints или downloads для проанализированных сессий.

- **Фаза 4**
  - внедрить operator state: allow/deny/watch lists и pause flags.

- **Фаза 5**
  - отполировать settings в виде grouped safety console.

## 7) Итог

Самые ценные идеи Dexter для `solana-launcher` — это не сам CLI, а **operator ergonomics**:

- явные проверки готовности
- читаемые strategy profiles
- воспроизводимые данные
- управляемое состояние
- safety-gates перед рискованными действиями

Именно эти части имеет смысл переносить в первую очередь.
