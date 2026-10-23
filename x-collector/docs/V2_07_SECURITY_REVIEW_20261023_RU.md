# V2-07: consumers, аудит и логи — 23.10.2026

Проверка выполнена локально на Windows, только с искусственными ключами и сессиями.
Рабочие БД/ключи не читались и не менялись; merge и реальные действия X не выполнялись.
Рабочая ротация остаётся отдельным разрешаемым шагом.

## Совместимость читателей и писателей

| Данные / путь | Реализация и результат |
|---|---|
| X session: collector/account manager, import-session, x-login, health/control, xactions-refresh | `lib/trade/crypto.ts`: legacy AES-GCM и authenticated V2 envelope; загрузка ключей заново при каждой операции |
| Явное чтение X session через `src/x/session.ts` | `decryptBufferWithKeys`, legacy key и необязательный словарь V2 передаются явно |
| register.ts | Исправлен независимый legacy writer: теперь `encryptBuffer` |
| UI добавления collector/publisher account | Исправлен независимый legacy writer: теперь общий CJS `sealBytes` |
| autopost browser, account-check, history-collector, diagnose-publisher | `runtime.unseal` → общий CJS keyring |
| test-publish.cjs / x-publish-web.cjs | Исправлены независимые legacy readers: теперь общий `unsealBytes`; проверены в VM с подменёнными БД/браузером, без сети |
| x-login-web.cjs | `runtime.seal` → общий CJS keyring |
| AI provider secrets: store/providers | `runtime.seal/unseal` → общий CJS keyring |
| Тестовая ротация session + AI secrets | `key-rotation-core.cjs`; rollback и блокировка Worker подтверждены native PostgreSQL |
| Reply credentials/proxy | Отдельный `aesgcm:v1:<id>` keyring (`lib/reply/secrets.ts`), не формат XCKEYV2 |

Без ACTIVE_KEY_ID писатели сохраняют legacy. Явный неизвестный active ID,
отсутствующий/неправильный ключ и повреждённый envelope завершаются ошибкой.
Удалён stale legacy cache: удаление ключа из env теперь действительно блокирует
следующую операцию. Экспорт clearKeyCache сохранён для совместимости.

Reply при отсутствии REPLY_ENCRYPTION_KEYS использует MASTER_KEY как `master`.
Перед любым будущим удалением/заменой legacy MASTER_KEY необходимо отдельно
инвентаризировать Reply и обеспечить чтение его старых записей. Здесь этот переход
не выполнялся. `proxy_json` X accounts хранится отдельно и требует защиты доступа
к БД и бэкапам; шифрование X session не защищает это поле.

## Хранение аудита

`xc_auto_job_events` защищён триггерами от UPDATE/DELETE/TRUNCATE; внешние ключи
RESTRICT удерживают связанные jobs/attempts. Попытки завершаются в той же транзакции,
что и переход состояния; тесты проверяют откат при отказе записи события и гонку
двух клиентов. UPDATE attempts допустим для завершения попытки, события append-only.

Приложение записывает структурированные категории/коды ошибок вместо raw message,
cookie, prompt или X evidence. SQL CHECK требует JSON object, но не является
универсальным фильтром секретов для произвольного INSERT владельца БД.
Владелец/superuser может менять DDL/триггеры: это не криптографически защищённый журнал.

Текущее безопасное правило retention: события сохраняются бессрочно; автоматического
удаления нет. Лимиты ответа UI не ограничивают срок хранения. Конечный срок, архив,
контроль объёма, Windows ACL и проверка доступа к резервным копиям остаются пунктами
эксплуатационной приёмки. Не удалять uncertain/attempt evidence ради освобождения места.

## Очистка логов от секретов

Общий TS logger скрывает sensitive object fields, URI credentials, Basic/Bearer,
ct0, MASTER_KEY, keyring JSON, quoted/multiline JSON и binary buffers. Canary-тесты
проверяют отсутствие искусственного секрета в результате фильтрации. Старые CLI
login/import/health/accounts больше не печатают произвольные Error.message/cause;
разрешены только фиксированные keyring-коды и SQLSTATE. register выдаёт общее сообщение.
Autopost audit и его CLI используют структурированные/фиксированные ошибки.

Фильтр не даёт гарантии для произвольного секрета без имени поля. Нельзя передавать
raw session, request/response body или keyring в лог даже с фильтром. Существующие
рабочие логи не открывались, не переписывались и не удалялись. CLI register по-прежнему
принимает cookies через argv: shell history/process listing остаются риском; для
новых процедур следует использовать импорт защищённого файла либо видимый login.

Logger создаёт отдельные файлы на процесс/дату и ротирует по rotateMaxBytes;
порог размера не ограничивает суммарный объём. Автоочистки по возрасту/числу файлов
нет. POSIX modes 0700/0600 в коде не заменяют отдельную проверку Windows ACL.
Новая политика удаления исторических файлов в эту проверку не включена.

## Итог

Offline consumer compatibility и найденные утечки исправлены с регрессиями.
V2-07 не объявляется полностью закрытым: остаются эксплуатационная политика хранения,
проверка Windows ACL/бэкапов и отдельно разрешаемый rollout с прежним ключом для rollback.
После переноса исправлений поверх актуальной ветки 7bf9cff: 387/387 unit и 13/13
native PostgreSQL, test:postgres, typecheck/lint/build collector прошли. Frontend
analysis fixtures, TypeScript и build прошли при повторе; первый build завершился
SecurityFatalError с рекомендацией обновить Next.js из-за известной уязвимости.
Повтор не устраняет уязвимость; обновление зависимостей требует отдельной проверки.
Lint: 8 существующих предупреждений collector, 12 scoped frontend, ошибок нет.
Результаты команд и файлы приведены в локальном outputs/V2-07-security-review.md.
