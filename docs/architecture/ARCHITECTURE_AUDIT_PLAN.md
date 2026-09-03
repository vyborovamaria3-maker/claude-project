# План аудита и оздоровления архитектуры

Дата составления: 2026-09-02
Область: весь монорепозиторий `claude-project` (все продуктовые кодовые базы, git-история, CI/CD, инфраструктура)
Статус: утверждён к исполнению, работы не начаты

---

## 1. Принятые решения

| # | Вопрос | Решение | Кто решил |
|---|---|---|---|
| 1 | Переписывание git-истории | **Да, разрешено.** Но замеры показали, что оно почти не нужно: 95% грязи достижимо только из мёртвой линии истории и убирается удалением ветвей (§3, §5). `filter-repo` по `main` остаётся возможным, но по умолчанию **не выполняется** — обоснование в §5 | владелец |
| 2 | Владелец домена подписок | **`solana-subscription-service` (SolSub).** Его Prisma-схема становится каноном, `telegram-miniapp` превращается в тонкий клиент, биллинг `solana-launcher` отдаёт подписки SolSub | владелец |
| 3 | Судьба `trade.db` (1.6 ГБ SQLite) | **Поэтапная консолидация в существующий Postgres.** Обоснование и этапы — §6 | решение по данным замеров |
| 4 | `cockpit-tools`, `repo/`, `pumpfun-chart` | **`pumpfun-chart` и `repo/` — удалить; `cockpit-tools` — извлечь в отдельный репозиторий, затем удалить.** Обоснование — §7 | решение по данным замеров |

---

## 2. Базовые замеры (точка отсчёта на 2026-09-02)

| Метрика | Значение |
|---|---|
| Диск / файлы | 21.4 ГБ / 407 080 |
| Под git-контролем | 1 112 файлов, 1 204 коммита |
| `.git` | pack 743.64 МиБ + 39.42 МиБ garbage (20 объектов `tmp_obj_*`) |
| Корневых коммитов | **3** (см. §3) |
| Ветки | 25 локальных / 104 remote; открытых PR — 2 (#11, #10 draft) |
| Worktrees | 4, один вложен в сам репозиторий (`work/deploy-main`), два — в профиле другого пользователя |
| Кодовых баз | 6 продуктовых + 3 вспомогательных, общих пакетов между ними — 0 |
| Workflows | 19 (деплойных 5); один run висит `pending` 10 ч 30 мин |
| Тесты (tracked) | launcher 30, intelligence 21, admin-site 17, solsub 2, miniapp 0, memecoin 0 |
| `npm audit --omit=dev` | launcher 19 (4 high), solsub 30 (14 high), miniapp 1 low |
| Branch protection на `main` | недоступна (private без GitHub Pro) → **CI не является гейтом** |
| HEAD | `2d00428` = `origin/restore/trade-analysis-129-visible` (ветвь запушена, не потеряна), diverged от `main`: 182 ahead / 14 behind |
| Реальная remote `main` | `ef88d03` (2026-09-01T18:56:23Z); локальный `origin/main` устарел — требуется `git fetch` |

Целевые значения после выполнения плана: диск ≤ 3 ГБ, `.git` pack ≤ 40 МиБ (расчёт в §3), ветвей ≤ 15, корневых коммитов 1, high-уязвимостей в prod-зависимостях 0.

---

## 3. Ключевая находка: три несвязанные истории в одном репозитории

`git rev-list --all --max-parents=0` возвращает три parentless-коммита, все от 2026-07-22 с одинаковым сообщением «Initial import of claude-project workspace»:

| Корень | Ветвей на нём | Что это |
|---|---|---|
| `71a169b` | **123** | Живая линия: `origin/main`, HEAD, все `agent/*`, `review/*`, `deploy/*` |
| `ba14591` | **5** (4 из них есть на origin) | Мёртвая до-перезаписи линия: `agent/repo-hygiene-deploy`, `clean-main`, `codex/admin-login-error`, `codex/fix-production-stack` + локальная `backup/pre-lfs-codex-admin-login-error` |
| `59a0196` | **1** | Локальная `main` — сирота ровно из 1 коммита, не связана с `origin/main` |

Линия `ba14591` — это история **до** ранее выполненной перезаписи (имя ветки `backup/pre-lfs-*` прямо указывает на LFS-related rewrite). Её оставили в репозитории, и она до сих пор несёт секреты и мусор. Отсюда следует, что заявленное «переписывание истории» в большинстве пунктов сводится к удалению 5 ветвей, а не к `filter-repo` по 1 204 коммитам.

Локальная `main` (`59a0196`) — единственное, что делает достижимым 121 МБ блоб `solana-launcher/data/database-analytics.snapshot.json`. Пересоздание `main` от `origin/main` убирает этот блоб само собой.

### Карта грязи по достижимости

Размеры даны как **on-disk в pack** (сжатые) — именно они определяют экономию; в скобках сырой размер, если он существенно отличается.

| Артефакт | On-disk в pack | Достижим из | Как убрать |
|---|---|---|---|
| `solana-launcher.tgz` | **332.2 МБ** | **уже недостижим** (dangling) | `git gc --prune=now` |
| `potapoff-sync.tgz` | **312.4 МБ** | **уже недостижим** (dangling) | `git gc --prune=now` |
| `potapoff-sync-new.tgz` | 31.9 МБ | только `agent/repo-hygiene-deploy` | удаление ветви |
| `potapoff-sync-step2.tgz` | 12.0 МБ (сырой 33.8) | только `agent/repo-hygiene-deploy` | удаление ветви |
| `cockpit-tools/**` (1 378 блобов, 1 409 файлов) | 19.5 МБ | только `agent/repo-hygiene-deploy` | извлечь (W0.3) → удаление ветви |
| `database-analytics.snapshot.json` | 13.1 МБ (сырой 121) | только локальная `main` | пересоздать `main` от `origin/main` |
| `rooveterinaryinc.roo-cline-3.53.0.vsix` | 10.0 МБ (сырой 31.7) | 4 ветви линии `ba14591` **и** линия `main` (добавлен `71a169b`, удалён `cd631a1`) | не секрет; удаляется только `filter-repo`, см. §5 |
| `solana-launcher/.env.server` (POSTGRES_PASSWORD, RABBITMQ_PASSWORD, SECRET_KEY, CLOUDFLARE_TUNNEL_TOKEN) | ничтожно | только `agent/repo-hygiene-deploy` (local + origin) | удаление ветви |
| JWT в `pumpfun-chart/backend/candle-aggregator.js:1` | ничтожно | **`origin/main`**, 6 коммитов | ротация + удаление файла; purge истории опционален |
| 20 объектов garbage | 39.42 МБ | — | `git gc --prune=now` |

### Расчёт экономии

Текущий `size-pack` — 743.64 МиБ. Две крупнейшие позиции (644.6 МБ, 87% пака) **уже недостижимы** и снимаются одним `git gc --prune=now`, без каких-либо действий с ветвями. Удаление линии `ba14591` добавляет ~63 МБ, пересоздание `main` — 13 МБ. Итоговый ожидаемый pack — **~30-40 МиБ**, что согласуется с `diskUsage` на GitHub: 82.4 МБ при вдвое большем числе ветвей.

Практический вывод: **самое дешёвое действие даёт наибольший эффект**. `git gc --prune=now` (W0.6) освобождает 87% пака и не требует ни ротации, ни согласований.

---

## 4. Реестр находок

Идентификаторы использовать в коммитах и PR (`SEC-`, `ARCH-`, `OPS-`, `DEP-`). Идентификаторы `SEC-012` и `SEC-013`, встречающиеся в W0.1, принадлежат **предыдущему** аудиту (`security/audit/AUDIT_2026-08-18.md`) и приведены как ссылки на незакрытые пункты, а не как находки этого реестра.

### P0 — утечки

| ID | Находка | Локация |
|---|---|---|
| SEC-101 | JWT (содержит e-mail владельца, `action: token-api`) вклеен первой строкой отслеживаемого файла, присутствует на `origin/main` и в 6 коммитах | `pumpfun-chart/backend/candle-aggregator.js:1` |
| SEC-102 | Продакшн-креды в истории ветви: 4 секрета | `solana-launcher/.env.server` в коммите `082b8dc` / `84dc04f` |
| SEC-103 | Секрет-скан структурно не видит JWT: 6 правил, ни одного на `eyJ...` | `security/audit/secret-scan.py:20-27` |
| SEC-104 | Режим `--mode history` реализован, но не вызывается ни одним workflow | `secret-scan.py:100` vs `.github/workflows/security-gates.yml:32,38` |
| SEC-105 | Ротация из аудита 18.08 не выполнена. Живые креды в `.codex/config.toml` — literal-значения в 6 местах: `FIGMA_API_KEY` (строка 8), `HELIUS_API_KEYS` (13, набор ключей), `PERPLEXITY_API_KEY` (51), `FIRECRAWL_API_KEY` (58), `OPENAI_API_KEY` + `MILVUS_TOKEN` (84), плюс `api-key=` внутри `args` (74). Файл под `.gitignore:2`, но лежит на диске и попал в 4 worktree. Дополнительно: `.deploy/potapoff-20260729124355/.env*`, `work/potapoff-pages/.env.local`, активные Playwright-сессии X в `data/x-auth/storage-state.json` + 2 копии в `work/` | `security/audit/SECRET_ROTATION_REQUIRED.md` |

Следствие SEC-103 + SEC-104: `npm run hygiene:check` и `secret-scan --mode current` сегодня проходят зелёными при живом токене в индексе. Проверено локально: оба гейта возвращают 0.

### P1 — дефекты, вытекающие из дублирования

| ID | Находка | Локация |
|---|---|---|
| SEC-201 | Memo сопоставляется по всей сериализованной транзакции: `JSON.stringify(tx).includes(memo)` — совпадение в логах или данных любой инструкции считается оплатой | `telegram-miniapp/backend-new/src/services/solana.ts:139` |
| SEC-202 | То же классом слабее: fallback `JSON.stringify(logMessages).includes(nonce)` | `solana-subscription-service/apps/api/src/services/solana.service.ts:64` |
| SEC-203 | Dev-байпас аутентификации вызывается из продуктовых роутов оплаты; единственная защита — `NODE_ENV !== "production"` | `solana-launcher/lib/telegram/init-data.ts:80-86`, вызовы в `app/api/miniapp/verify-payment/route.ts:17-25`, `create-invoice/route.ts:30`, `order/route.ts:10` |
| SEC-204 | Четыре реализации initData с расходящейся семантикой. Python-версия: `auth_date` проверяется **до** HMAC (строки 110-111 против 116), окна future-skew нет вовсе — `_utcnow() - auth_date > timedelta(...)` для timestamp из будущего даёт отрицательную разницу и проходит; `json.loads(user_raw)` без обработки исключения (122). solsub-версия сортирует уже склеенные строки `k=v` вместо сортировки по ключу и не валидирует hex. miniapp-версия — побайтовая копия launcher-версии | `solana-launcher/backend/app/services/auth.py:94-123`; `solana-launcher/lib/telegram/init-data.ts:14-78`; `telegram-miniapp/backend-new/src/security/telegram.ts:22-86`; `solana-subscription-service/apps/api/src/security/telegram.ts:47-123` |
| SEC-205 | JWT одновременно живёт в httpOnly-cookie `potapoff_access_token` и в `localStorage["potapoff.access_token"]`, откуда уходит как `Authorization: Bearer`. Запись в `localStorage` в 3 местах, чтение в 2, удаление в 1 — httpOnly-защита обесценена полностью. Отдельно: токен попадает в URL redirect'а, то есть в историю браузера, Referer и логи | запись: `components/PasswordLoginForm.tsx:43`, `components/PublicLandingPage.tsx:650`; чтение: `lib/clientAuth.ts:1-14`, `app/telegram-intelligence/page.tsx:63`; cookie: `lib/routeAuth.ts:5`, `backend/app/api/deps.py:16`; URL: `backend/app/api/v1/auth.py:454` |
| SEC-206 | Контракт miniapp разъехался: фронт отправляет `telegramId` / `?userId=`, бэкенд требует подписанный `initData` | `telegram-miniapp/frontend/src/lib/api.ts:76,87` vs `backend-new/src/controllers/subscriptionController.ts:15,33,79-80` |

Эталон для SEC-201/202 находится в этом же репозитории: `solana-launcher/lib/telegram/solana-pay.ts:146-196` — Solana Pay reference через `getSignaturesForAddress`, только `finalized`, отсечение по `blockTime`, проверка reference в `accountKeys`, суммы в BigInt base-units, дельты pre/post token balance.

### P2 — архитектурная стоимость

| ID | Находка | Локация / масштаб |
|---|---|---|
| ARCH-301 | Между четырьмя кодовыми базами нет ни одного общего пакета. Единственный существующий — `@solsub/shared`, и он подключён только к `apps/api` (`apps/api/package.json:23`, импорты в `prisma/seed.ts:2` и `services/subscription.service.ts:10`); `apps/web` и `apps/bot` его не подключают вовсе. Корневой `package.json` — 6 прокси-скриптов, не workspace | `solana-subscription-service/packages/shared`, `tsconfig.base.json:16-17` (path-alias есть, но только внутри solsub) |
| ARCH-302 | Три несовместимые модели тарификации. **solsub**: цены в коде — `PLAN_DEFINITIONS` с `monthlySol/yearlySol` 0.1/1, 0.5/5, 2/20 (`packages/shared/src/index.ts:17-39`), курс SOL→USD зашит `const demoSolUsd = 150` (`subscription.service.ts:175`). **miniapp**: `const amount = 1000` USDT (`subscriptionController.ts:42`), срок `365` дней литералом в аргументе (`webhookController.ts:93`), та же цифра текстом в двух местах бота (`bot/bot.ts:39,73`). **launcher**: цены в БД, задаются админом (`SubscriptionSettings`), тарифов как таковых нет | см. локации в описании |
| ARCH-303 | Построение Solana Pay URL реализовано трижды, с тремя разными подходами к сборке: строковая интерполяция с `URLSearchParams`, конструктор `new URL('solana:' + recipient)`, третий вариант в launcher | `launcher lib/telegram/solana-pay.ts:60` (`buildSolanaPayUrl`), `solsub apps/api/src/services/solana.service.ts:15,32` (`buildSolanaPayUrl`), `miniapp backend-new/src/services/solana.ts:8,13` (`generateSolanaPayUrl`) |
| ARCH-304 | **15 отдельных `new Connection()`** (проверено `git grep` по отслеживаемым `.ts`/`.tsx`); механизм ротации ключей существует, но используется только внутри `lib/trade`. Ни один из 15 вызовов ротацию не применяет. Дополнительно 4 кустарные `rpc<T>()`-обёртки на голом `fetch` | ротация: `lib/trade/helius-rotation.ts:4-70`. `new Connection`: `bundler/buy:138`, `bundler/create-token:85`, `bundler/submit-tx:47`, `MasterWalletCard.tsx:82,129,157`, `FundWalletsCard.tsx:66,101`, `WarmupWalletsCard.tsx:85,188`, `MasterWalletBar.tsx:24`, `solana-pay.ts:165`, `creator-fee-agent.ts:174` (QuickNode), `solana-wallet-warmup/src/index.ts:387`, `solsub solana.service.ts:6`. `rpc<T>()`: `token-analytics/route.ts:83`, `token-dev/route.ts:14`, `token-holders/route.ts:29`, `lib/trade/dev.ts:16` |
| ARCH-305 | Четыре бот-процесса, три библиотеки. **launcher**: telegraf, транспорт выбирается по `NODE_ENV` — в prod `setWebhook` + пустой цикл ожидания (`telegram-bot/index.ts:64-88`), апдейты приходят в Next-роут (`app/api/telegram/webhook/route.ts:69`), в dev `bot.launch()` polling (`index.ts:93`): один бот с двумя точками входа в разных средах. **solsub**: команды `/start`, `/status`, `/upgrade`, `/cancel` реализованы **дважды** — в telegraf-боте (`apps/bot/src/index.ts:20,27,51,55`) и параллельно разбором текста в API (`apps/api/src/routes/webhook.routes.ts:89,95,103,106`). **miniapp**: `node-telegram-bot-api`. **intelligence**: Telethon (MTProto, юзер-аккаунт) | `solana-launcher/telegram-bot/index.ts`, `app/api/telegram/webhook/route.ts`; `solsub apps/bot/src/index.ts` + `apps/api/src/routes/webhook.routes.ts`; `telegram-miniapp/bot/bot.ts`; `backend/app/services/telegram_intelligence.py:70` |
| ARCH-306 | 8 хранилищ, 3 разных SQLite-стека; бесхозные файлы БД | Postgres×2 (SQLAlchemy, Prisma), SQLite×3 (better-sqlite3, Prisma, stdlib `sqlite3`), Redis, RabbitMQ; бесхозные: корневой `miniapp.db`, `solana-launcher/backend/local-test.db`, `data/dev-backend.db` |
| ARCH-307 | Единственная точка интеграции между кодовыми базами сломана: admin-site монтирует `../telegram-miniapp/backend-new/prisma` как `/data/miniapp:ro`, но ищет в нём `dev.db`, тогда как на диске лежит `miniapp.db` | `admin-site/sources.example.json:29` (`file:/data/miniapp/dev.db?mode=ro`) vs `admin-site/docker-compose.yml:40` |
| ARCH-308 | Нет корневой инженерной основы: отсутствуют `turbo.json`/`nx.json`/`pnpm-workspace.yaml`, `Makefile`, `.nvmrc`, корневой `tsconfig.base.json`, `.editorconfig`, `renovate.json`/dependabot, `CODEOWNERS`, issue templates. **14 отслеживаемых `package.json`, 6 отслеживаемых lock-файлов**, `engines` объявлен лишь в 3 из 14 и с тремя разными порогами (`>=18.0.0`, `>=20`, `>=22.0.0`), локально Node v24. Следствие: `@next/swc` лежит в 5 копиях (101-131 МБ каждая), из них 3 вне `work/` | корень репозитория |
| OPS-309 | CI широкий, но негейтящий: 19 workflow, 12 на `pull_request`, branch protection недоступна → merge при красном CI возможен | `.github/workflows/*` |
| OPS-310 | Мёртвое LFS-правило: путь одновременно в `.gitattributes`, в `.gitignore` и не отслеживается | `.gitattributes:1` |
| OPS-311 | `potapoff-production.yml` помечен «(legacy)», деплой переехал на сервер, но workflow активен; один run висит `pending` 10 ч 30 мин | `.github/workflows/potapoff-production.yml` |
| OPS-312 | Тесты не покрывают денежные пути: miniapp 0, solsub 2 файла / 7 кейсов. У memecoin `npm test` — цепочка ad-hoc скриптов, не фреймворк | `memecoin-intelligence/package.json` (`test:network`, `check:syntax`, …) |
| ARCH-313 | Мёртвый код в дереве: `cockpit-tools/` (192 МБ артефактов без исходников на диске), `repo/` (клон постороннего awesome-list), `_tmp-vnc/` (только node_modules), `pumpfun-chart/` (159 строк, нигде не используется) | см. §7 |
| OPS-314 | Pre-commit-хуки фактически не работают: конфиг лежит по пути `solana-launcher/pre-commit-config.yaml` — **без ведущей точки**, поэтому `pre-commit` его не находит. Единственный экземпляр на весь монорепозиторий, покрывает только Python в `backend` | `solana-launcher/pre-commit-config.yaml` |

### P3 — дисковая гигиена

| ID | Находка | Объём |
|---|---|---|
| OPS-401 | `.bot.err.log`: `polling_error` логируется с полным дампом объекта без троттлинга; при двух живых экземплярах бота `409 Conflict` писался 10 дней | 6.3 ГБ; причина — `telegram-miniapp/bot/bot.ts:113` |
| OPS-402 | Пять копий `trade.db`: `data/`, `solana-launcher/data/`, `solana-launcher/.next/standalone/data/`, `work/potapoff-export/data/`, `work/potapoff-pages/data/` | ~7 ГБ |
| OPS-403 | `work/potapoff-pages/` и `work/potapoff-export/` не содержат ни одного исходника — свалки build-артефактов. **Не** в `.gitignore` и видны как untracked: `git add -A` затянет их в индекс | ~3.6 ГБ |
| OPS-404 | Turbopack-кэши, `deploy-tools/` (только node_modules), `.playwright-mcp/`, `_tmp-vnc/` | ~0.6 ГБ |

---

## 5. W0 — Локализация утечек и очистка истории

Выполняется первой, блокирует все остальные волны. Порядок внутри волны обязателен: ротация до удаления, извлечение `cockpit-tools` до удаления ветви.

| Шаг | Действие | Критерий приёмки |
|---|---|---|
| W0.1 | Отозвать у провайдера JWT из `candle-aggregator.js:1`. Отозвать/перевыпустить всё из SEC-105 и незакрытых пунктов прошлого аудита: `FIGMA_API_KEY`, `HELIUS_API_KEYS`, `PERPLEXITY_API_KEY`, `FIRECRAWL_API_KEY`, `OPENAI_API_KEY`, `MILVUS_TOKEN`, Telegram bot token (**SEC-012** из `SECRET_ROTATION_REQUIRED.md`), внешний `sk-`-ключ (**SEC-013** оттуда же), `POSTGRES_PASSWORD`, `RABBITMQ_PASSWORD`, `SECRET_KEY`, `CLOUDFLARE_TUNNEL_TOKEN` из `.env.server`. Инвалидировать сессию X | Каждый ключ отозван; дата и исполнитель внесены в `security/audit/SECRET_ROTATION_REQUIRED.md`; старые значения не работают (проверить запросом) |
| W0.2 | Вынести секреты из `.codex/config.toml` во внешний менеджер (env / SOPS / 1Password CLI). Конкретные позиции: строки 8, 13, 51, 58, 74, 84 — `FIGMA_API_KEY`, `HELIUS_API_KEYS`, `PERPLEXITY_API_KEY`, `FIRECRAWL_API_KEY`, `api-key=` в `args`, `OPENAI_API_KEY`, `MILVUS_TOKEN`. В файле оставить только ссылки на переменные | В файле ни одного literal-ключа; все 18 MCP-серверов запускаются |
| W0.3 | Извлечь `cockpit-tools` в отдельный репозиторий из ветви `agent/repo-hygiene-deploy` (1 409 файлов исходников, включая `src-tauri/Cargo.toml`, `src-tauri/src/**`). **На диске исходников нет — только артефакты; на `origin/main` их тоже нет.** Это единственный носитель кода | Новый репозиторий собирается: `npm ci` + `cargo build` проходят |
| W0.4 | Удалить ветви линии `ba14591`. На origin существуют 4: `agent/repo-hygiene-deploy`, `clean-main`, `codex/admin-login-error`, `codex/fix-production-stack`; `backup/pre-lfs-codex-admin-login-error` — только локально. Убирает `.env.server` (SEC-102), ~44 МБ tgz и 19.5 МБ cockpit-блобов. **Перед удалением проверить `codex/*`**: у них 344-365 «уникальных» коммитов, но выборочная сверка тем показала, что содержательные изменения уже присутствуют на `main` под другими SHA (следствие перезаписи истории); уникальны только верхние 1-2 коммита каждой ветви | `git rev-list --all --max-parents=0` не содержит `ba14591`; ни одна фича не потеряна (сверка по темам коммитов) |
| W0.5 | Пересоздать локальную `main` от `origin/main` (`git fetch origin && git branch -f main origin/main`). Сирота `59a0196` перестаёт быть достижимой, вместе с ней уходит 13.1 МБ блоба `database-analytics.snapshot.json` | `git rev-list main` даёт > 1 000 коммитов; `git rev-list --all --max-parents=0` возвращает ровно `71a169b` |
| W0.6 | `git worktree prune`; вынести `work/deploy-main` за пределы репозитория; `git gc --prune=now --aggressive`. **Это самый результативный шаг очистки**: снимает 644.6 МБ уже недостижимых `solana-launcher.tgz` + `potapoff-sync.tgz` (87% пака) и 39.42 МБ garbage | `git count-objects -vH` без warnings, `size-pack` ≤ 40 МиБ, `garbage: 0` |
| W0.7 | Удалить `pumpfun-chart/` целиком (см. §7). Это же закрывает SEC-101 на `main` | `git show main:pumpfun-chart/backend/candle-aggregator.js` возвращает ошибку |
| W0.8 | Расширить `security/audit/secret-scan.py`: правила на JWT (`eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.`), Solana base58-приватник (64 байта), `AIza`, `xox[baprs]-`, generic high-entropy для значений `*_TOKEN` / `*_SECRET` / `*_PASSWORD`. Правило `.js`-файлов уже покрыто `TEXT_SUFFIXES:41` — не хватало именно JWT-паттерна | На состоянии дерева **до** W0.7 скан падает и указывает `pumpfun-chart/...: jwt`; после W0.7 проходит |
| W0.9 | Добавить в `security-gates.yml` job `secret-scan-history` с `--mode history` (режим уже реализован в `secret-scan.py:100`, но нигде не вызывается). Запускать nightly, не на PR: полный проход по 1 204 коммитам дорог | Job существует, первый прогон формирует baseline, повторный прогон зелёный |
| W0.10 | Дополнить `docs/architecture/REPOSITORY_HYGIENE.md` разделом про secret-scan и явно указать, что hygiene-гейт **не** проверяет содержимое (это уже написано в строке 15, но не связано с secret-scan как парным контролем) | Документ описывает оба контроля и их разделение ответственности |

### Про `filter-repo`

Полное переписывание истории по всем ветвям **не требуется**. После W0.4 + W0.5 + W0.6 в истории остаются лишь два артефакта: JWT на линии `main` (SEC-101, 6 коммитов) и `.vsix` (10 МБ в паке; добавлен `71a169b`, удалён `cd631a1` — не секрет).

Рекомендация: JWT после ротации (W0.1) теряет ценность, поэтому purge истории `main` — **опционально**. Если решено выполнять, делать это отдельной задачей после W0.5, единым `git filter-repo --path pumpfun-chart --path solana-launcher/rooveterinaryinc.roo-cline-3.53.0.vsix --invert-paths`, с обязательным предварительным `git clone --mirror` в бэкап. Операция требует force-push в `main`, ломает 2 внешних worktree и все клоны, инвалидирует SHA в 2 открытых PR. Ожидаемая выгода — 10 МБ pack (сжатый размер `.vsix`) и удаление уже отозванного токена. Соотношение выгоды и риска низкое; по умолчанию **не выполняем**, решение фиксируется отдельно.

---

## 6. Решение по `trade.db` (вопрос 3)

### Что установлено замерами

| Факт | Локация |
|---|---|
| 1.59 ГБ, 38 таблиц; крупнейшие: `migration_wallet_rows` 648 904, `database_wallet_summary` 251 089, `wallet_tags` 235 549, `migration_token_rows` 97 467, `database_token_summary` 97 380 | `solana-launcher/data/trade.db` |
| Наполняется офлайн-импортом 4 208 XLSX-файлов; таблицы `twitter_*`, `market_events`, `apify_*`, `database_token_buyer_edges` пусты | `scripts/import-migration-xlsx.cjs` |
| БД открывается **на запись** как глобальный синглтон, WAL, `synchronous = NORMAL`. **`busy_timeout` не задан** — он есть только в `scripts/cleanup-cache.cjs:70` | `lib/trade/db.ts:457-470` |
| При каждом вызове `getDb()` выполняется `init()` — **66 DDL-инструкций** `CREATE TABLE/INDEX IF NOT EXISTS` | `lib/trade/db.ts:468`, DDL на строках 31-448 |
| GET-обработчик API вызывает `ensureWalletSummary(db)`, который внутри `db.transaction()` делает `DELETE FROM database_wallet_summary` и полную перестройку 251 089 строк. Мьютекса нет, rate limit 60 req/min | `app/api/database/wallets/route.ts:280` → `:136-218`, лимит `:9-10` |
| Второй пишущий GET-роут | `app/api/trade/dev-twitter/route.ts` |
| В прод-compose файл отдаётся контейнеру bind-mount'ом `./data:/app/data`; `replicas` не объявлены | `docker-compose.production.yml:150-151` |
| `admin-site` открывает тот же файл read-only с `mode=ro`, `PRAGMA query_only=ON`, `timeout=5` | `admin-site/app/database.py:142-145` |

### Вывод

Комбинация «SQLite WAL + один писатель + отсутствие `busy_timeout` + тяжёлая перестройка из GET-пути» означает, что параллельный запрос получает `SQLITE_BUSY` немедленно, а не ждёт. Читатель из `admin-site` с `timeout=5` отваливается, пока писатель держит лок. Bind-mount файла делает горизонтальное масштабирование frontend-контейнера невозможным в принципе.

### Решение: поэтапная консолидация в существующий Postgres

Postgres `16-alpine` уже развёрнут в прод-compose — новая инфраструктура не нужна. Это решающий аргумент против DuckDB/ClickHouse.

**Фаза A — снять аварийность, без миграции данных (входит в W1, 1 день):**

1. `db.pragma("busy_timeout = 5000")` в `lib/trade/db.ts` рядом с остальными pragma.
2. Вынести `ensureWalletSummary` из GET-пути в отдельную задачу: CLI-скрипт + вызов после импорта XLSX. GET только читает и возвращает `409`/устаревший снапшот, если сводка не готова.
3. Убрать `init()` из `getDb()` (`db.ts:468`): 66 DDL при каждом обращении. Выполнять миграции отдельной командой при старте/деплое.
4. Открывать соединение `{ readonly: true }` во всех путях, которые только читают.

**Фаза B — перенести производные таблицы (входит в W4, ~3 дня):** `database_wallet_summary`, `database_token_summary`, `database_wallet_token_summary`, `wallet_tags`, `wallet_stats` полностью пересчитываются из сырых данных, поэтому переносятся без риска потери. Перестройка становится задачей Celery/BullMQ вместо HTTP-обработчика.

**Фаза C — перенести сырой слой (входит в W4, ~1 неделя):** `migration_wallet_rows` (648 k), `migration_token_rows` (97 k), `token_trades`, `dev_tokens`, `dev_forensics_analyses` → Postgres. Импортёр XLSX пишет напрямую в Postgres. SQLite остаётся только как формат промежуточного staging при офлайн-импорте либо удаляется совсем.

**Что удалить сразу (W1):** пустые таблицы `twitter_*`, `market_events`, `apify_*`, `database_token_buyer_edges` — 4 группы неиспользуемых DDL из `lib/trade/db.ts`.

---

## 7. Решение по `cockpit-tools`, `repo/`, `pumpfun-chart` (вопрос 4)

| Каталог | Что установлено | Решение |
|---|---|---|
| `cockpit-tools/` | На диске 192 МБ / 14 871 файл: только `dist/`, `node_modules/`, `src-tauri/target/debug/`, логи. **Нет** `src/`, `package.json`, `Cargo.toml`, ни одного `.md`. Исходники (1 409 файлов, 1 378 блобов, 19.5 МБ в паке) существуют **исключительно** в ветви `agent/repo-hygiene-deploy`; на `origin/main` их 0. Продукт не связан с POTAPoff — это Tauri+React менеджер аккаунтов AI-ассистентов v1.3.15 | **Извлечь в отдельный репозиторий из ветви (W0.3), затем удалить каталог с диска.** Порядок критичен: удаление ветви в W0.4 уничтожит единственную копию кода |
| `repo/` | Shallow-клон постороннего `github.com/iSoumyaDey/Awesome-Web-Hosting-2026`. Не отслеживается, уже в `.gitignore` | **Удалить с диска.** Никаких предварительных действий |
| `pumpfun-chart/` | 159 строк (`CandleAggregator`, OHLCV 1s–1h). Нет `package.json`, README, фронтенда. Единственная ссылка во всём репозитории — описание в `BACKTEST_SUMMARY.md:72-77` («standalone утилита», «зависимостей нет»), импортов ноль. Функциональность **уже реализована** в launcher: `lib/chart/aggregate.ts`, `lib/chart/aggregator.ts`, `lib/chart/types.ts`, `app/api/token-ohlcv/route.ts`, `app/api/token-history/route.ts`. Первой строкой файла — JWT (SEC-101) | **Удалить целиком (W0.7).** Дубликат существующего кода; удаление одновременно закрывает SEC-101 на `main`. Удалить раздел `## 3. PUMPFUN-CHART` из `BACKTEST_SUMMARY.md` |
| `_tmp-vnc/` | Только `node_modules` (`@computernewb/nodejs-rfb`), брошенная песочница. Не отслеживается | **Удалить с диска** (W1.4) |
| `work/potapoff-pages/`, `work/potapoff-export/` | ~3.6 ГБ build-артефактов без единого исходника. Дубликаты сборок `deploy-main/solana-launcher` | **Удалить с диска** (W1.4) |
| `work/deploy-tools/` | Только `node_modules` (`ssh2-sftp-client`), без `package.json` | **Удалить с диска** (W1.4) |

---

## 8. W1 — Остановить кровотечение: диск, git, аварийные pragma

Срок: 1 день. Не зависит от W2-W5, но выполняется после W0.

| Шаг | Действие | Критерий приёмки |
|---|---|---|
| W1.1 | Исправить причину OPS-401, не симптом: в `telegram-miniapp/bot/bot.ts:113` логировать `error.code` + `error.message` вместо объекта, ввести троттлинг (не чаще 1 записи в минуту на код ошибки). Гарантировать единственный экземпляр бота (lock-файл или `pm2 --instances 1`) | Искусственно вызванный `409 Conflict` даёт ≤ 1 строку в минуту |
| W1.2 | Удалить `telegram-miniapp/bot/.bot.err.log` (6.3 ГБ). Настроить ротацию: `pm2-logrotate` либо `max_size=50M`, `retain=3` | Ни одного файла лога > 50 МБ во всём дереве |
| W1.3 | Закрыть OPS-402: оставить одну копию `trade.db` — канон `solana-launcher/data/trade.db`. Удалить `data/trade.db`, `solana-launcher/.next/standalone/data/trade.db`, обе копии в `work/`. Путь задавать через `TRADE_DB_PATH`, а не относительным `data/` | 1 файл вместо 5, освобождено ~5.7 ГБ |
| W1.4 | Закрыть OPS-404 и ARCH-313: удалить с диска `work/potapoff-pages/`, `work/potapoff-export/`, `work/deploy-tools/`, `_tmp-vnc/`, `.playwright-mcp/`, `repo/`, turbopack-кэши, `cockpit-tools/` (только после W0.3) | Итог по диску ≤ 3 ГБ |
| W1.5 | Закрыть OPS-403: внести в `.gitignore` `work/` целиком (allowlist для нужного), `cockpit-tools/`, `_tmp-vnc/`, `.playwright-mcp/`. Сейчас `work/collective-ai-tools/` и `work/deploy-main/` видны как untracked — `git add -A` затянет 5 ГБ и вложенный `.git` | `git status --porcelain` пуст |
| W1.6 | Устранить OPS-310: удалить мёртвое LFS-правило из `.gitattributes` (путь одновременно в `.gitignore` и не отслеживается) либо начать реально трекать файл через LFS | Ни одного правила LFS на ignored/untracked путь |
| W1.7 | Усилить `scripts/repository-hygiene.mjs`: запрет вложенных `.git`, запрет untracked-путей вне ignore-списка, порог `MAX_TRACKED_BYTES` снизить с 10 МиБ (`repository-hygiene.mjs:5`) до 5 МиБ. **Проверено: снижение порога безопасно** — сейчас ни один отслеживаемый файл не превышает 5 МиБ, крупнейшие `solana-launcher/lingo/metadata-dev/data.mdb` (1.25 МиБ) и `.codex-market-overview.png` (1.07 МиБ). Отдельно рассмотреть удаление legacy-исключения `POTAPoff-landing-minimal-v3.zip` (`repository-hygiene.mjs:6-7`) | Гейт падает при попытке добавить `work/**` или вложенный репозиторий; текущий индекс проходит без изменений |
| W1.8 | **Фаза A из §6** — аварийные правки `trade.db`: `busy_timeout = 5000`; вынести `ensureWalletSummary` из GET-пути (`app/api/database/wallets/route.ts:280`) в CLI/фоновую задачу; убрать `init()` из `getDb()` (`lib/trade/db.ts:468`, 66 DDL при каждом обращении); открывать `{ readonly: true }` на read-only путях | Параллельные запросы к `/api/database/wallets` не дают `SQLITE_BUSY`; `admin-site` с `timeout=5` читает без ошибок под нагрузкой |
| W1.9 | Удалить DDL пустых неиспользуемых таблиц из `lib/trade/db.ts`: `twitter_*`, `market_events`, `apify_*`, `database_token_buyer_edges` | Число DDL-инструкций в `init()` сокращено; функциональность не затронута |

---

## 9. W2 — Инженерная основа монорепозитория

Срок: 3-5 дней. Блокирует W3 (без workspace физически нет места для `packages/`).

| Шаг | Действие | Критерий приёмки |
|---|---|---|
| W2.1 | Ввести **pnpm workspaces + Turborepo**. Обоснование: 14 отслеживаемых `package.json` и 6 lock-файлов дают несовместимые деревья зависимостей — `@next/swc` присутствует в 5 копиях по 101-131 МБ. Отдельно: у `memecoin-intelligence` lock-файла нет вовсе, CI ставит зависимости через `npm install --no-audit --no-fund` (`memecoin-intelligence.yml:29`), то есть сборка невоспроизводима. Ещё одно следствие разрозненности: `apps/web` solsub сидит на `next@14.2.35` (21 high-advisory), а launcher уже на `^16.2.11` и чист | Один `pnpm-lock.yaml`; `turbo.json` с задачами `build`, `lint`, `typecheck`, `test`; `pnpm install` из корня поднимает все пакеты |
| W2.2 | Единая версия Node: `.nvmrc` + `engines` во всех манифестах. Сейчас `engines` объявлен в 3 из 14 и с тремя разными порогами: `>=18.0.0` (`solana-wallet-warmup`), `>=20` (memecoin), `>=22.0.0` (solsub); локально стоит v24 | CI и локальная среда на одной мажорной версии (рекомендация — 22 LTS) |
| W2.3 | Корневой `tsconfig.base.json` со `strict: true`; все TS-проекты через `extends` | `pnpm turbo typecheck` зелёный из корня |
| W2.4 | Единая линтовка: ESLint flat config + Prettier для TS; ruff + mypy для Python; корневой `.editorconfig`. Закрывает OPS-314: конфиг pre-commit существует **только** в `solana-launcher/pre-commit-config.yaml` (ruff v0.6.9 + mypy v1.11.2) и под именем без ведущей точки, поэтому хук локально не срабатывает. В CI ruff/mypy вызываются напрямую в 3 workflow (`full-backtest-audit.yml:179,183`, `telegram-intelligence-v19-ci.yml:46,48`, `trade-intelligence-quality.yml:58`) и только по каталогу `backend` | Один прогон из корня; файл переименован в `.pre-commit-config.yaml` и покрывает весь монорепозиторий; `pre-commit run --all-files` проходит |
| W2.5 | Python-зависимости: `admin-site/requirements.txt` (8 пинов) и `intelligence/requirements.txt` (2 пина) перевести на `pyproject.toml` + lock, как уже сделано в `solana-launcher/backend`. Отдельно: `memecoin-intelligence/ai/qwen-service/requirements.txt` — 9 зависимостей, **ни одна не запинена** (`torch`, `transformers`, `bitsandbytes` без версий) | Все Python-зависимости запинены и воспроизводимы |
| W2.6 | Корневой `Makefile`/`justfile` с реальными командами вместо 6 прокси-скриптов в `package.json` | `just dev <app>`, `just test`, `just audit` работают |
| W2.7 | Закрыть ARCH-308 в остатке: добавить `renovate.json` (или dependabot), `CODEOWNERS`, PR/issue-шаблоны — то, чего нет в корне. Удалить каталоги по §7 (после W0.3 для cockpit) | Все перечисленные в ARCH-308 файлы существуют; в дереве нет каталогов без исходников |
| W2.8 | Не ломать существующую защиту при переходе на pnpm: `xlsx@^0.18.5` объявлен в **devDependencies**, а рантайм-импорт перехватывается локальным shim'ом `scripts/xlsx-safe-package` (Python-парсер stdlib, `shell: false`, лимиты на размер архива и число ячеек, отказ от DTD). Механизм подменяет `Module._load` в `scripts/import-migration-xlsx.cjs:10-11`. Проверить, что после смены менеджера пакетов подмена продолжает работать | Импорт XLSX проходит через shim, а не через SheetJS; тест `scripts/xlsx-safe-package/test.mjs` зелёный |

---

## 10. W3 — Консолидация домена

Срок: 1-2 недели. Главная архитектурная работа. Создаётся корневой `packages/`, дубликаты **физически удаляются**, а не оставляются «на всякий случай».

| Пакет | Содержимое | Что заменяет |
|---|---|---|
| `@potapoff/telegram-auth` | Одна TS-реализация initData + Login Widget: hex-валидация, `timingSafeEqual`, порядок «сначала HMAC, потом `auth_date`», TTL и future-skew из конфига, обе схемы вывода секрета (`sha256(botToken)` для widget, `HMAC("WebAppData", botToken)` для Mini App) | SEC-204: 3 TS-копии. Python-версия (`auth.py:94-123`) приводится к той же семантике и покрывается тем же набором векторов |
| `@potapoff/solana-payments` | Одна проверка платежа по эталону `lib/telegram/solana-pay.ts:146-196` + единый билдер Pay-URL | SEC-201, SEC-202, ARCH-303 |
| `@potapoff/solana-rpc` | Фабрика `Connection` с ротацией ключей на базе `lib/trade/helius-rotation.ts:4-70`, retry/backoff, единый резолвер endpoint. Покрывает и клиентские компоненты (`MasterWalletCard`, `FundWalletsCard`, `WarmupWalletsCard`, `MasterWalletBar`), и серверные роуты, и `solana-wallet-warmup` | ARCH-304: 15 `new Connection()` + 4 `rpc<T>()`-обёртки |
| `@potapoff/billing` | Тарифы, периоды, конвертация валют, срок доступа — **источник только БД, ноль числовых констант в коде**. Курс SOL→USD берётся из внешнего оракула, а не из литерала | ARCH-302: `PLAN_DEFINITIONS` 0.1/1…2/20, `demoSolUsd = 150`, `amount = 1000`, `365` дней |

Порядок внутри волны обязателен. Нумерация шагов используется в §14 и §15 как `W3.1`…`W3.7`:

| Шаг | Действие | Критерий приёмки |
|---|---|---|
| W3.1 | Создать `@potapoff/telegram-auth`, покрыть property-тестами: подмена `hash`, replay за пределами TTL, **timestamp из будущего** (сейчас Python-версия его пропускает), отсутствие поля `user`, невалидный JSON в `user`, невалидный hex, инъекция `\n` в значения полей, отсутствие `signature` у Mini App. Затем **физически удалить** три TS-копии и привести Python-версию к той же семантике | Ни одного собственного `verifyTelegramInitData` вне пакета; все 8 векторов покрыты негативными тестами |
| W3.2 | Создать `@potapoff/solana-payments`. Обязательный regression-тест на SEC-201/202: транзакция, где memo присутствует в `logMessages` или в данных посторонней инструкции, но отсутствует в memo-инструкции, должна быть **отвергнута**. Затем удалить три реализации проверки и три билдера Pay-URL | Тест на подделку memo падает до фикса и проходит после; `JSON.stringify(...).includes(...)` отсутствует в коде проверки платежей |
| W3.3 | Убрать dev-байпас (SEC-203): вместо проверки `NODE_ENV` — явный флаг `ALLOW_DEV_TELEGRAM_USER`, плюс fail-fast при старте, если флаг включён одновременно с `NODE_ENV=production` | Приложение не стартует при `ALLOW_DEV_TELEGRAM_USER=1` в prod; `getDevTelegramUser` недостижим из роутов оплаты |
| W3.4 | Убрать `localStorage` для токена (SEC-205): удалить запись в `PasswordLoginForm.tsx:43` и `PublicLandingPage.tsx:650`, чтение в `lib/clientAuth.ts` и `app/telegram-intelligence/page.tsx:63` перевести на cookie-сессию, оставить httpOnly-cookie + CSRF double-submit по образцу solsub (`apps/api/src/security/cookies.ts:5-31`). Убрать токен из redirect-URL (`backend/app/api/v1/auth.py:454`) — передавать одноразовый код обмена либо ставить cookie на стороне сервера | `potapoff.access_token` не встречается ни в записи, ни в чтении; `scripts/security-regression.mjs` дополнен проверкой **отсутствия** `localStorage` |
| W3.5 | Синхронизировать контракт miniapp (SEC-206): фронт передаёт `initData` в заголовке `x-telegram-init-data`, параметр `?userId=` удалить | Контрактный тест падает при расхождении фронта и бэкенда |
| W3.6 | Свести боты (ARCH-305): оставить реализацию команд solsub в `apps/bot/src/index.ts:20-55`, из `apps/api/src/routes/webhook.routes.ts:89-106` удалить разбор текста, оставив вебхуку только проксирование апдейта. У launcher выбрать один транспорт: prod-ветка `telegram-bot/index.ts:64-88` держит процесс живым исключительно ради healthcheck'а, тогда как апдейты обрабатывает Next-роут — либо убрать пустой процесс, либо перевести prod на polling. Telethon-разведка остаётся отдельно: другой класс (MTProto, юзер-аккаунт) | Одна реализация каждой команды; один транспорт на бота |
| W3.7 | Создать `@potapoff/solana-rpc` и `@potapoff/billing`, перевести на них все 15 `new Connection()`, 4 `rpc<T>()`-обёртки и все числовые константы тарифов (ARCH-302, ARCH-304). Закрывает ARCH-301: пакеты подключаются минимум к двум кодовым базам каждый | `new Connection(` вне пакета отсутствует; ни одной цены-литерала в коде |

---

## 11. W4 — Границы сервисов и данные

Срок: 1-2 недели. Требует завершённого W3.

| Шаг | Действие | Обоснование |
|---|---|---|
| W4.1 | Реализовать решение №2: **SolSub — владелец подписок**. `telegram-miniapp` становится его клиентом (свою Prisma/SQLite-модель теряет), `solana-launcher` спрашивает статус подписки у SolSub вместо собственных `SubscriptionOrder` / `SubscriptionSettings` | Сегодня три источника истины о том, оплачен ли доступ |
| W4.2 | Канон схемы — `solana-subscription-service/apps/api/prisma/schema.prisma` (7 моделей, enum'ы, индексы `[userId,status]`, `[endsAt]`). Написать миграцию данных из `SubscriptionOrder` (launcher) и `Payment` (miniapp) | Устраняет ARCH-306 в части подписок |
| W4.3 | **Фазы B и C из §6**: производные таблицы, затем сырой слой `trade.db` → Postgres. Перестройка сводных таблиц становится задачей Celery/BullMQ | Снимает bind-mount `./data:/app/data` (`docker-compose.production.yml:150-151`) и открывает горизонтальное масштабирование frontend |
| W4.4 | Починить ARCH-307: `sources.example.json:29` ждёт `dev.db`, на диске `miniapp.db`. После W4.1 источник вообще меняется — miniapp теряет свою БД, admin-site должен смотреть в Postgres SolSub. Источники задавать через ENV, а не через пример конфига | Единственная реальная точка интеграции сейчас нерабочая |
| W4.5 | Удалить бесхозные БД: корневой `miniapp.db`, `solana-launcher/backend/local-test.db`, `solana-launcher/data/dev-backend.db` | Снимает неоднозначность, какая БД настоящая |
| W4.6 | Написать `docs/architecture/SERVICES.md`: кто владеет какими данными, кто чей клиент, какие контракты между сервисами. Сейчас в `docs/` единственный файл — про гигиену репозитория | Без зафиксированных границ результат W3 расползётся обратно |

---

## 12. W5 — CI/CD как настоящий гейт

Срок: 3-5 дней, частично параллельно W2.

| Шаг | Действие | Критерий приёмки |
|---|---|---|
| W5.1 | Закрыть OPS-309: включить branch protection на `main` — required checks (hygiene, secret-scan, typecheck, test), запрет force-push, линейная история. Требуется GitHub Pro либо перенос в организацию: сейчас API отдаёт `403 Upgrade to GitHub Pro`, то есть **гейта нет вообще**. Выполнять раньше остальных волн, иначе любой результат может быть перезаписан прямым push | Merge при красном CI невозможен |
| W5.2 | Свернуть 19 workflow в 4: `ci.yml` (матрица по пакетам через `turbo` affected), `security.yml`, `deploy.yml`, `nightly.yml`. Дублирующиеся setup-шаги вынести в composite action. Удалить заглушку `solana-launcher-deploy.yml` и legacy `potapoff-production.yml` (OPS-311) | ≤ 5 файлов workflow; время прогона PR сокращено |
| W5.3 | Разобраться с висящим run на self-hosted runner (OPS-311, `pending` 10 ч 30 мин): выставить `timeout-minutes` и `concurrency.cancel-in-progress` для всех не-деплойных workflow | Ни одного run дольше объявленного таймаута |
| W5.4 | Добавить `renovate.json` или dependabot: 5 lock-файлов обновляются вручную, отсюда 14 high в solsub и 4 high в launcher | Автоматические PR на обновления зависимостей |
| W5.5 | Закрыть уязвимости. **solsub — 30 (14 high)**, крупнейший кластер — `next@14.2.35` в `apps/web` (21 advisory: SSRF в rewrites и Server Actions, cache poisoning, XSS в App Router с CSP nonce, множественные DoS), далее `postcss`, `nanoid`, `valibot` → `@telegram-apps/sdk-react`, `deepmerge-ts` → `prisma`. **launcher — 19 (4 high)**, все четыре от одного корня `bigint-buffer` → `@solana/buffer-layout-utils` → `@solana/spl-token` → `@lightprotocol/compressed-token`; сам `next@^16.2.11` в launcher чист. Приоритет: поднять Next в solsub до 16.x (launcher уже проверен на этой мажорной версии), затем разбор кластера `bigint-buffer` | `npm audit --omit=dev` без high во всех пакетах |
| W5.6 | Добавить `CODEOWNERS` и PR-шаблон с чеклистом «затронуты ли auth / payment» | Изменения в `packages/telegram-auth` и `packages/solana-payments` требуют явного ревью |
| W5.7 | Закрыть OPS-312: vitest в `telegram-miniapp` (сейчас 0 тестов), расширить solsub с 7 кейсов, `memecoin-intelligence` перевести с цепочки ad-hoc скриптов (`check:syntax`, `test:network`, `test:fixtures`, …) на vitest | Каждый путь оплаты и авторизации имеет negative-тесты |
| W5.8 | Гигиена ветвей: после W0.4 остаётся ~99 remote-ветвей, преимущественно отработавшие `agent/*`, `deploy/landing-v2-*`, `review/01..10`, `tmp-ignore-do-not-use`. Смерджить или удалить. Отдельно разрешить расхождение HEAD и `main` (182 ahead / 14 behind): ветвь `restore/trade-analysis-129-visible` содержит 182 неслитых коммита, включая `feat: integrate audited trade intelligence production release` — либо оформить PR, либо явно отказаться | ≤ 15 активных ветвей; HEAD не diverged |

---

## 13. Целевая архитектура

```
claude-project/                      pnpm workspaces + turborepo
├── packages/
│   ├── telegram-auth/               1 реализация initData (было 4)
│   ├── solana-payments/             1 верификатор + 1 билдер Pay-URL (было 3+3)
│   ├── solana-rpc/                  Connection factory + ротация ключей (было 15)
│   ├── billing/                     тарифы из БД, 0 числовых констант
│   └── config/                      базовые tsconfig / eslint / prettier
├── apps/
│   ├── launcher-web/                Next.js: лончер, форензика, дашборды
│   ├── launcher-api/                FastAPI: разведка, Celery, Telethon
│   ├── subscription-api/            владелец подписок (Express + Prisma + Postgres)
│   ├── miniapp/                     тонкий клиент subscription-api
│   ├── bot/                         один telegraf-процесс
│   ├── admin/                       FastAPI read-only, источники из ENV
│   └── intelligence/                memecoin + off-chain, свои Postgres/Redis
├── infra/                           compose / nginx / deploy — сегодня разбросано
└── docs/architecture/               SERVICES.md, DATA.md, SECURITY.md
```

Ключевой инвариант: **проверка подписи Telegram и проверка платежа существуют в единственном экземпляре**. Всё остальное в этом плане — производное от него.

---

## 14. Последовательность и зависимости

```
W0 (сегодня, блокирует всё)
 └─ W1 (1 день) ──┬─ W2 (3-5 дн) ── W3 (1-2 нед) ── W4 (1-2 нед)
                  └─ W5.1 + W5.3 (параллельно W2)
                     W5.2, W5.4-W5.8 (после W2: нужен turbo affected)
```

Жёсткие зависимости:

- W0.3 строго до W0.4 — иначе удаление ветви уничтожает единственную копию исходников `cockpit-tools`.
- W0.1 строго до W0.4/W0.7 — сначала ротация, потом удаление носителей.
- W3 невозможен без W2: нет workspace, значит нет места для `packages/`.
- W4 после W3: нельзя выбрать владельца подписок, пока логика размазана по трём копиям.
- W5.1 как можно раньше: без branch protection любую волну можно перезаписать прямым push в `main`.

Оценка при одном исполнителе: W0+W1 — 2 дня, W2 — неделя, W3 — 2 недели, W4 — 2 недели, W5 — распределённо. Итого ~5-6 недель.

Если нужен быстрый результат: **W0, W1, W3.1, W3.2, W5.1** дают основную часть снижения риска за первую неделю.

---

## 15. Подготовка к деплою на сервер

### Что установлено о текущем процессе деплоя

| Факт | Локация |
|---|---|
| Деплой server-side: `deploy-production.sh <image-tag>`, 206 строк, `set -Eeuo pipefail`, `trap rollback ERR` | `solana-launcher/scripts/deploy-production.sh` |
| Каталог на сервере `/opt/potapoff-deploy`; админка отдельно в `/opt/claude-project/admin-site` | `deploy-production.sh:6,11` |
| Обязательно должны существовать: `.env.server`, `backend.env`, `docker-compose.production.yml`, `scripts/backup-production.sh`, `scripts/healthcheck-production.sh`, `prometheus/prometheus.yml`, `admin-site/docker-compose.yml` | `deploy-production.sh:16-22` |
| Общая docker-сеть `potapoff-shared` создаётся при отсутствии | `deploy-production.sh:26` |
| Предыдущий тег хранится в `.current-image-tag`, используется для откота | `deploy-production.sh:43-44,138` |
| Бэкап перед деплоем: env-файлы + `pg_dump -Fc` базы `potapoff`, `sha256sum`, retention 14 дней | `backup-production.sh:12-36` |
| Alembic: 11 ревизий, 2 merge-узла, **единственный настоящий head** `0010_advanced_intelligence` — `upgrade heads` корректен | `backend/alembic/versions/` |
| Healthcheck: до 45 попыток; проверяет `/`, `/miniapp`, `/trade/analysis`, `/trade/analysis/social`, `/fastapi/health`, `/api/build-info`, `/admin/`, состояния контейнеров, Telegram webhook | `healthcheck-production.sh:137-168` |
| Nightly-бэкап по cron 02:30 через SSH | `.github/workflows/potapoff-backup.yml:5,46` |

### Риски деплоя, выявленные при аудите

| ID | Риск | Локация | Действие до первого деплоя |
|---|---|---|---|
| DEP-501 | **`trade.db` (1.6 ГБ) не входит ни в один бэкап.** `backup-production.sh` снимает только Postgres и env-файлы, а база отдаётся контейнеру bind-mount'ом `./data:/app/data`. Потеря или повреждение файла невосстановимы | `backup-production.sh:12-36` vs `docker-compose.production.yml:150-151` | Добавить в `backup-production.sh` шаг `sqlite3 trade.db ".backup"` (онлайн-бэкап, корректен при WAL) с проверкой целостности и включением в `SHA256SUMS` |
| DEP-502 | **Миграции применяются после подъёма контейнеров** (`up -d` на строке 192, `alembic upgrade heads` на 197): существует окно, когда новый код работает против старой схемы | `deploy-production.sh:192,197` | Либо перенести миграции до `up -d`, либо принять правило «только обратно совместимые миграции» и зафиксировать его в `docs/architecture/SERVICES.md` |
| DEP-503 | **`rollback()` не откатывает схему БД** — `downgrade` не вызывается нигде. Необратимая миграция делает откат образов бессмысленным | `deploy-production.sh:126-167` | Обязательное правило: каждая миграция имеет рабочий `downgrade`; в rollback добавить `alembic downgrade` до ревизии, соответствующей `PREVIOUS_TAG` |
| DEP-504 | При пустом `.current-image-tag` откат невозможен: «manual recovery is required» | `deploy-production.sh:133-136` | Перед первым деплоем убедиться, что файл существует и содержит рабочий тег |
| DEP-505 | Изменения W1.8 (`busy_timeout`, вынос перестройки сводных таблиц из GET) меняют поведение `/api/database/wallets` — эндпоинт покрыт healthcheck'ом опосредованно, через `/trade/analysis` | `healthcheck-production.sh:154-158` | Добавить в healthcheck прямую проверку `/api/database/wallets` |

### Чеклист подготовки к деплою

Порядок обязателен.

1. Убедиться, что W0 полностью выполнен: ротация подтверждена, `secret-scan --mode current` и `--mode history` зелёные, `git rev-list --all --max-parents=0` возвращает единственный корень.
2. Закрыть DEP-501: `trade.db` включён в `backup-production.sh`, тестовое восстановление из бэкапа выполнено на staging.
3. Принять решение по DEP-502/DEP-503 и зафиксировать его в документации; при выборе «downgrade обязателен» — проверить наличие рабочего `downgrade` во всех 11 ревизиях.
4. Прогнать локально: `pnpm turbo typecheck lint test build`, `npm audit --omit=dev` (без high), `npm run hygiene:check`, `python security/audit/secret-scan.py --mode current`.
5. Прогнать миграции на копии продакшн-базы: `alembic upgrade heads`, затем `alembic downgrade` до предыдущей ревизии и снова `upgrade`.
6. Проверить `.env.server` и `backend.env` на сервере: все переменные, добавленные волнами W1-W4, присутствуют; **ротированные в W0.1 значения обновлены**. Без этого шага деплой упадёт на старых кредах.
7. Собрать образы и запушить в GHCR с тегом = SHA коммита.
8. Зафиксировать текущий `.current-image-tag` как точку откота (DEP-504).
9. Выполнить `deploy-production.sh <new-tag>`. Ожидаемый вывод: `DEPLOYMENT_OK tag=<new-tag>`.
10. Проверить вручную то, что не покрыто healthcheck'ом: оплата подписки end-to-end на devnet, вход через Telegram Mini App, `/api/database/wallets` под параллельной нагрузкой (DEP-505).
11. При провале — `rollback` срабатывает автоматически по `trap ERR`; убедиться в выводе `ROLLBACK_OK tag=<previous>` и в согласованности схемы БД.

### Правило разбиения на деплои

Не деплоить W0-W5 одним пакетом. Порядок выпусков:

| Выпуск | Содержание | Почему отдельно |
|---|---|---|
| R1 | W0 + W1 (секреты, диск, аварийные pragma) | Не меняет схему БД и публичные контракты; откат тривиален |
| R2 | W2 (сборка, линт, workspace) | Меняет только процесс сборки; проверяется на CI до деплоя |
| R3 | W3.1-W3.2 (`telegram-auth`, `solana-payments`) | Затрагивает аутентификацию и оплату: деплоить в одиночку, с ручной проверкой обоих путей |
| R4 | W3.3-W3.7 (dev-байпас, cookies, контракт miniapp, боты, shared-пакеты) | Изменение поведения авторизации + миграция на единые пакеты: требует отдельного окна |
| R5 | W4 (границы сервисов, миграция данных) | Необратимые миграции данных: обязательны бэкап и проверенный `downgrade` |
| R6 | W5 (CI/CD, зависимости) | Инфраструктура, продакшн-код не затрагивает |

---

## 16. Как отслеживать прогресс

Все находки имеют идентификаторы `SEC-*`, `ARCH-*`, `OPS-*`, `DEP-*`. Правила работы:

- Идентификатор указывается в сообщении коммита и в заголовке PR.
- Находка закрывается только при выполненном критерии приёмки из соответствующей таблицы, а не по факту внесения правки.
- При закрытии `SEC-*` обновляется `security/audit/SECRET_ROTATION_REQUIRED.md` либо соответствующий отчёт в `security/audit/`.
- Замеры из §2 перепроверяются после каждой волны; расхождение с целевыми значениями — повод не закрывать волну.
