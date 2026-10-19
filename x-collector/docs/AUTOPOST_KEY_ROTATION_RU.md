# X Autopost V2-07 — инвентаризация и репетиция ротации ключей

**Статус: mixed-format readers реализованы в коде, рабочая ротация не разрешена.** Файл не является инструкцией немедленно менять `MASTER_KEY` на работающей машине.

## Что реально зашифровано ключом

| Хранилище | Поле | Формат сейчас | Читатели/писатели |
|---|---|---|---|
| PostgreSQL `x_accounts` | `session_encrypted BYTEA` | AES-256-GCM, `IV(12) + TAG(16) + ciphertext` | `lib/trade/crypto.ts`, `src/x/session.ts`, `scripts/autopost/runtime.cjs`, `scripts/x-login-web.cjs`, account manager |
| PostgreSQL `xc_ai_providers` | `secret BYTEA` | тот же legacy AES-GCM | `scripts/autopost/runtime.cjs`, `providers.cjs`, `store.cjs` |
| PostgreSQL `reply_accounts` | `credentials_encrypted`, `proxy_encrypted` | **другой** envelope `aesgcm:v1:<key-id>:...` и свой keyring | `lib/reply/secrets.ts`, `scripts/reply/rotate-key.ts` |

`REPLY_ENCRYPTION_KEYS` управляется отдельно: **не** запускать две ротации одновременно. Telegram / TG-invite vault и внешние сервисы имеют собственные секреты и в область V2-07 X Autopost не входят. `proxy_json` в X accounts содержит отдельные чувствительные настройки: оно не зашифровано `MASTER_KEY`, и его нужно защищать правами БД/бэкапами.

## Безопасная команда для продакшена: только чтение

Из каталога `x-collector`:

```powershell
node scripts/autopost/rotate-keys.cjs --dry-run
```

Если тестовая БД уже содержит V2-записи, укажите `X_COLLECTOR_NEXT_MASTER_KEY` и `X_COLLECTOR_NEXT_KEY_ID` для корректного чтения *обоих* форматов; без них V2-записи намеренно не расшифруются.

Команда открывает SQL-транзакцию `READ ONLY`, батчами проверяет теги AES-GCM и формат X-сессий, считает старые и версионированные записи. Выводит **только агрегированные количества**, без cookie, токенов, имён аккаунтов, ключей, ошибок с URL и содержимого шифротекстов. При ошибке откатывает транзакцию и возвращает ненулевой exit code.

## Новый тестовый формат и репетиция

`key-rotation-core.cjs` описывает envelope `XCKEYV2! + длина ID + ASCII key ID + IV(12) + TAG(16) + ciphertext`, при этом шапка аутентифицирована как AES-GCM AAD. Чтение поддерживает legacy и V2 (при наличии соответствующих ключей в памяти). Это **подготовка формата**, а не переключение продакшен-писателей.

Для репетиции в **изолированной PostgreSQL с именем, заканчивающимся на `_test`**, отдельными `MASTER_KEY` и `X_COLLECTOR_NEXT_MASTER_KEY` и `X_COLLECTOR_NEXT_KEY_ID`:

```powershell
node scripts/autopost/rotate-keys.cjs --dry-run
node scripts/autopost/rotate-keys.cjs --apply-test-only --confirm-backup --confirm-worker-stopped
```

Только после действительного бэкапа и остановки тестового Worker. Код проверяет суффикс имени БД `_test`, проверяет отсутствие свежего heartbeat живого Worker, блокирует таблицы, последовательно расшифровывает, валидирует и заново шифрует записи. Ошибка в любом шаге вызывает **ROLLBACK всей операции**.

Важно: читатели `x-collector/lib/trade/crypto.ts`, `src/x/session.ts`, `scripts/autopost/runtime.cjs` и `scripts/x-login-web.cjs` **поддерживают mixed legacy/V2** после настройки keyring. Записи в production всё ещё шифруются legacy по умолчанию. Поэтому **никогда** не запускать test-only ротацию на рабочей БД и не заменять прежний `MASTER_KEY`, даже если dry-run успешен.

## Гейт перед настоящей ротацией

1. Зафиксировать/проверить резервную копию тестовой и затем рабочей БД *вне Git*; отдельно защитить и проверить восстановление прежнего ключа.
2. Обновить **все** шифрующие и расшифровывающие consumer-процессы на совместимый versioned keyring (включая login/import, collector, publisher, AI).
3. Протестировать mixed legacy/V2, отсутствие ключа, повреждённый ciphertext, невозможность читать без нужного key ID, rollback и параллельный запуск Worker.
4. Согласовать maintenance window. Остановить Worker, дождаться завершения `attempted` или оставить `uncertain` без повторной отправки. Не запускать второй Worker.
5. Backup + recovery rehearsal, проверка SHA/CI, тестовая реальная PostgreSQL, read-only status, только потом отдельно разрешать рабочую ротацию.
6. При неуспехе **не удалять старый ключ**. Секреты и снимки базы никогда не коммитить. Служебные логи не должны содержать `MASTER_KEY`, сессии, raw exceptions, AI credentials.

**Live X не использовался. Production keys не менялись.**

## Offline mixed-format keyring (инкремент 2)

- `X_COLLECTOR_ENCRYPTION_KEYS` — JSON-словарь ID → 32-байтовый ключ в hex/base64. Ключи хранить только в защищённой среде на ноутбуке, **не** в git. Формат ID: латиница, цифры, `_`, `-`; длина до 48.
- `MASTER_KEY` остаётся обязательным legacy-ключом до завершения перехода и успешного восстановления из бэкапа.
- `X_COLLECTOR_ACTIVE_KEY_ID` **не устанавливать в рабочей среде до отдельного разрешения**. Без него все писатели (collector/import, видимый browser-login, publisher/AI) шифруют по-старому.
- Если оператор явно установил `X_COLLECTOR_ACTIVE_KEY_ID`, выбранного ID нет в keyring или envelope подделан, код завершает операцию с ошибкой, без молчаливого fallback на старый ключ.
- В `scripts/autopost/keyring.cjs` и `lib/trade/crypto.ts` один совместимый формат; перекрёстные тесты доказывают совместимость. `src/x/session.ts` по-прежнему принимает явный старый ключ и необязательные новые ключи для read-only чтения.
- Test-only CLI `rotate-keys.cjs` использует старый `MASTER_KEY` и отдельные `X_COLLECTOR_NEXT_MASTER_KEY/X_COLLECTOR_NEXT_KEY_ID`; это **не** переключает production runtime.
