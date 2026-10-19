# V2-05: EXPLAIN очереди на искусственных данных, 20.10.2026

**Исходный замер до оптимизации: функциональный приоритет подтверждён; обнаружены performance failures.**
Текущее состояние после оптимизации описано в последнем разделе этого отчёта.
Runtime `queue.cjs` не менялся. Измеряется точный SQL, полученный вызовом
`dueJobs`, через `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`.

## Стенд и данные

- Windows, PostgreSQL 16.15, новый disposable database
  `x_collector_queue_v205_test` на `127.0.0.1:55432` в отдельном тестовом кластере.
- Уникальная схема с настоящим `scripts/autopost/schema.sql`, индексами и audit
  triggers. `x_accounts` содержит только необходимые queue metadata;
  шифротексты, сессии и ключи отсутствуют. `ANALYZE` выполнен после загрузки.
- 100 искусственных publisher accounts, enabled configs, daily_limit=4.
- 200004 jobs: 100000 старых published/attempted, 80000 готовых agent,
  20000 будущих agent, 4 свежих manual после старых agent.
- Для quota-exhausted добавлены ещё 400 сегодняшних attempted jobs
  (по 4 на аккаунт), итог этого сценария — 200404 jobs.
- Worker, браузер, AI, X и рабочая PostgreSQL-служба не запускались/не менялись.
  Тестовая схема удалена в finally; контрольное удаление индекса откатывается.

## EXPLAIN ANALYZE: основной масштаб

| Сценарий | Execution Time | Строки | Shared hit / read | Индексы |
|---|---:|---:|---:|---|
| Mixed, priority index, 3 прогона | 34.734 / 41.711 / 40.691 мс | 20 | 31576 / 0 каждый | manual_due + account |
| Planner paused, index present, 3 прогона | 58.898 / 54.781 / 64.100 мс | 4 | 4337 / 0 каждый | planner выбрал scan + sort |
| Planner paused, priority index временно удалён | 60.321 мс | 4 | 4337 / 0 | scan + sort |
| Все аккаунты busy | **statement timeout 15000 мс** | результат не получен | не измерено | ANALYZE не завершился |
| Все agent daily quotas exhausted | **statement timeout 15000 мс** | результат не получен | не измерено | ANALYZE не завершился |

Для завершённых планов temp read/written = 0. Все измерения тёплые, без
принудительной очистки ОС/PG cache. 15 секунд — предохранитель стенда,
не согласованный production SLA; точная длительность запросов после этой
границы неизвестна. Наличие timeout не скрывается успешным exit code harness:
он обозначает завершение измерений и проверку инвариантов, а не performance PASS.

Проверено настоящим `dueJobs`: первые четыре строки — manual, затем agent,
всего LIMIT 20; при paused возвращаются только эти четыре manual.
Индекс `xc_auto_jobs_manual_due` реально используется в mixed-плане. Его
наличие не гарантирует использование PostgreSQL во всех распределениях.
Контроль без индекса выполнен только для paused: это не замер ускорения mixed.

## Диагностика на меньшем масштабе

Повторён тот же harness на 10004 jobs: 5000 history, 4000 ready agent,
1000 future agent, 4 manual; quota scenario добавляет ещё 400 jobs.

| Сценарий | Execution Time |
|---|---:|
| Mixed, 3 прогона | 1.589 / 1.524 / 1.495 мс |
| Paused, 3 прогона | 2.542 / 2.560 / 2.530 мс |
| Paused без priority index | 3.163 мс |
| Все аккаунты busy | 400.119 мс, 0 строк |
| Все agent quotas exhausted | 429.006 мс, 4 manual строки |

В обоих крайних сценариях `Aggregate` дневной квоты выполняется **4000 раз**,
по одному на готовое agent job вместо одного на аккаунт. Под ним повторяется
Bitmap Heap Scan истории аккаунта через `xc_auto_jobs_account`: 100 отфильтрованных
исторических строк на loop. В busy-плане работа квоты выполняется до отбрасывания
всех результатов по занятости аккаунтов. В mixed-плане aggregate loops=16.
Это подтверждённый источник лишней работы на меньшем наборе и вероятная
причина плохого масштабирования; полные actual plans больших timeout-сценариев
недоступны, поэтому их точное время/loops не утверждаются.

## Повторение

Из `x-collector`, с отдельной loopback БД `_test`:

```powershell
$env:RUNTIME_TEST_DATABASE_URL = '<URL отдельной локальной *_test БД>'
$env:QUEUE_BENCHMARK_OUTPUT = '<абсолютный путь к JSON вне Git>'
$env:QUEUE_BENCHMARK_ROWS = '200000'
node scripts/autopost/queue-benchmark.cjs
```

Для диагностики заменить rows на 10000. Поле rows — базовый набор без четырёх
manual и дополнительных 400 quota fixtures. Harness ограничивает размер,
проверяет loopback и суффикс `_test`, не загружает `.env`, не запускает Worker,
читает schema.sql относительно своего файла, сохраняет планы без секретов.
Ключи не требуются. Линтер нового harness прошёл.

## Решение

V2-05 нельзя закрыть по производительности. Следующий изолированный шаг —
убрать повторный per-job подсчёт квоты (рассмотреть расчёт по аккаунтам и
подходящий partial index) и раннее исключение недопустимых аккаунтов.
Сохранить manual-first, расписания, лимиты, breaker/account locks, legacy dedup
и запрет повторной отправки uncertain. Сравнить оба масштаба и выполнить
PostgreSQL-регрессии; только потом решать об изменении runtime.

Замер не доказывает SLA, холодный cache, многопользовательскую нагрузку,
масштабы другого ноутбука или реальную публикацию X. Live X: NOT TESTED.


## После оптимизации account-level quota (20.10.2026)

### Изменение

- Один MATERIALIZED CTE вычисляет разрешённые аккаунты и agent eligibility,
  а не пересчитывает квоту для каждого queued job. Membership-проверки в основном
  SELECT сохраняют обе ветви manual/agent без повторных nested-loop проходов
  по списку аккаунтов для каждого задания.
- Additive partial expression index xc_auto_jobs_attempted_quota:
  `(account_name, COALESCE(attempted_at,started_at)) WHERE attempted`.
  Устанавливается только обычным schema.sql setup, не автоматически Worker-ом.
- Сохранены status/role/busy и breaker filters, календарный cutoff, start/end
  (включая ночное окно), pause, manual-first перед LIMIT 20. Manual по-прежнему
  не требует enabled config и свободной дневной квоты, но требует допустимый
  аккаунт. Считаются все attempted после cutoff независимо от status, включая
  uncertain и future timestamp; fallback started_at не заменяет заданный attempted_at.
- claim/account lease, advisory lock, browser guard, dedup и send-boundary не менялись.

### Повтор того же harness на том же объёме

| Сценарий | До | После | Quota aggregate loops после |
|---|---:|---:|---:|
| Mixed (3 прогона) | 34.734 / 41.711 / 40.691 мс | 2.696 / 18.854 / 2.134 мс | 100 каждый |
| Paused (3 прогона) | 58.898 / 54.781 / 64.100 мс | 80.738 / 52.979 / 48.092 мс | 0 |
| Paused без priority index, диагностический контроль | 60.321 мс | 54.613 мс | 0 |
| Все аккаунты busy | timeout >15000 мс | 53.449 мс, 0 строк | 0 |
| Все agent quotas exhausted | timeout >15000 мс | 54.555 мс, 4 manual | 100 |

Состав: те же 200004 исходных jobs и 100 accounts; quota-exhausted — 200404.
В mixed shared hits упали с 31576 до 406, physical reads=0; использованы оба
индекса quota/manual_due. Во всех завершённых сценариях temp read/written=0.
Paused shared hits=2804, busy=2805, exhausted=3606, physical reads=0.
Индексы не форсировались. EXPLAIN выполнялся на том же ноутбуке с тёплым cache;
параллельно шли регрессионные тесты, поэтому отдельный выброс paused 80.738 мс
не трактуется как устойчивое ухудшение/улучшение. Медиана paused 52.979 мс
против исходных 58.898 мс; это не строгий статистический SLA.

Функциональные assertions harness прошли; исходные timeout-сценарии завершились
за <60 мс. Performance gap закрыт на измеренном наборе. Большая кардинальность
аккаунтов, холодный cache, реальные профили нагрузки и live X не проверены.

### Регрессионная защита

Новые общие PGlite/native PostgreSQL fixtures проверяют все перечисленные
условия допуска, manual exemption, точные границы времени, COALESCE/attempted
семантику и приоритет. С 240 лишними заданиями исчерпанного аккаунта EXPLAIN
требует число aggregate loops не больше числа аккаунтов. До исправления тест
падал на обоих движках с 250 loops при 12 аккаунтах; после проходит.
Схема применяется дважды, проверяя идемпотентность additive индекса.

Рабочая БД, реальные ключи, X и merge не использовались. Перед рабочим применением
индекса требуется отдельное штатное обновление схемы с проверенным backup;
этот отчёт не является разрешением выполнить его на рабочей базе.


Итоговая локальная регрессия после оптимизации: typecheck PASS; lint PASS
(0 errors, 8 существующих warnings); build PASS; npm test 368/368, 0 fail/skip;
настоящий PostgreSQL test:db 13/13, 0 fail/skip; test:postgres PASS.
Отдельный targeted набор quota/manual-priority/native: 3/3. UI не изменялся
и повторно не собирался в этом инкременте. Рабочая схема не обновлялась.
