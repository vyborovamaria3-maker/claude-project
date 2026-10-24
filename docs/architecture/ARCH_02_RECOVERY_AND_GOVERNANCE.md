# ARCH-02 — SSH pinning, проверка backup/restore и управление ветками

**Статус:** реализация в draft PR над `main`, без запуска на боевом сервере, без доступа к продуктивным X/TG/Blockchain БД и без изменения GitHub Secrets. Этот PR независим от архитектурной цепочки #133–#145.

## 1. Безопасность SSH: что изменилось

Единый `.github/scripts/prepare-pinned-ssh.sh` используется для:
- `.github/workflows/ssh-check.yml` (только ручная проверка);
- `.github/workflows/potapoff-backup.yml` (резервное копирование);
- `.github/workflows/potapoff-production.yml` (production deploy);
- `.github/workflows/landing-release.yml` (landing deploy).

Скрипт проверяет host, port, user, ключ клиента, одну запись `known_hosts`, а также **второй, отдельно доверенный** SHA256-отпечаток ключа хоста. Для порта не 22 требуется точная запись `[HOST]:PORT`; запись просто `HOST` не проходит. В SSH включены `StrictHostKeyChecking=yes`, `UpdateHostKeys=no`, `IdentitiesOnly=yes`, `BatchMode=yes`, `ForwardAgent=no` и отдельный `UserKnownHostsFile`. `ssh-keyscan` никогда не служит подтверждением доверия.

### Обязательная ручная настройка GitHub Secrets

Нужно сохранить (в защищённых Secrets GitHub, не в коде) шесть значений: `SERVER_HOST`, `SERVER_PORT`, `SERVER_USER`, `SERVER_SSH_KEY`, `SERVER_SSH_KNOWN_HOSTS`, **новый** `SERVER_SSH_HOST_KEY_SHA256`. GHCR credentials задаются отдельно для публикации/загрузки образов.

Получите действительный публичный host key **по доверенному каналу**: через консоль облачного провайдера или имеющийся достоверный доступ к серверу, например файл `/etc/ssh/ssh_host_ed25519_key.pub`. На самой доверенной консоли выполните:

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256
```

Сопоставьте SHA256-фингерпринт с фактическим публичным ключом этого сервера. Содержимое `SERVER_SSH_KNOWN_HOSTS` для нестандартного порта должно иметь форму:

```text
[server.example.com]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA...<полное значение из доверенного host public key>
```

`SERVER_SSH_HOST_KEY_SHA256` — значение `SHA256:...` из независимой проверки. Здесь показаны исключительно **фиктивные примеры**, их нельзя копировать как реальные ключи. Не добавляйте увиденный впервые ключ без сверки по доверенному каналу и не используйте `StrictHostKeyChecking=no`. Для изменения/ротации host key требуется обновить оба связанных секрета. Разрешена **одна точно pinned host key** для данного host:port: намеренно запрещена неоднозначная пачка старых и новых ключей.

⚠️ Пока новый секрет не настроен, production backup/deploy/SSH workflows будут отказывать **до сетевого подключения**. Это корректная защита, а не причина временно отключать проверки. Сначала вручную запустите workflow `SSH connection check`; не начинайте deploy, если pin не прошёл.

## 2. Резервные копии без ложных успехов

`solana-launcher/scripts/backup-production.sh` теперь:
- Создаёт временную `.incomplete-*` директорию с ограниченными правами, **не** публикует неуспешный архив как завершённый;
- Требует обязательные серверные конфигурации, архивы обеих PostgreSQL и Control Center `.env`; дампы создаются только через уже существующие контейнеры;
- Проверяет `pg_restore --list` у обоих custom-format архивов и SHA256 всех файлов;
- Перемещает архив в окончательное timestamp-имя **после** проверки; только после этого чистит завершённые старые архивы;
- При ошибке удаляет только свою неполную временную директорию, не трогая проверенные старые копии.

Конфигурационные файлы содержат **секреты в открытом виде**. Каталог backup имеет mode 0700, но для полноценной защиты нужно отдельное зашифрованное offsite-хранилище, ротация ключей и политика retention; копирование секретов в CI artifacts и публичные логи запрещено.

## 3. Проверка фактического восстановления — только в изолированный Docker

Новый `solana-launcher/scripts/verify-backup-restore.sh` принимает **только путь к завершённой резервной копии**. Он проверяет SHA256 и создаёт новый временный контейнер PostgreSQL 17 без сети, проброшенных портов и постоянных volumes, а затем восстанавливает в **две новые базы внутри контейнера** product/admin dumps. Дополнительно проверяет, что таблицы действительно появились. По завершении контейнер удаляется.

```bash
# ТОЛЬКО на машине, где лежит завершённый backup:
bash /opt/potapoff-deploy/scripts/verify-backup-restore.sh /opt/potapoff-deploy/backups/YYYYMMDD-HHMMSS
```

Нужны Docker и достаточное дисковое пространство под **два полных восстановления одновременно**. Тест не направляет запросы в production PostgreSQL, но временный контейнер всё равно содержит реальные секретные данные из дампов — запускать только на доверенной инфраструктуре. Используемый `postgres:17-alpine` должен быть доступен; если исходный dump создан более новой версией PostgreSQL, заранее выберите соответствующий восстановительный image после отдельного ревью.

Новая GitHub Actions проверка `ARCH-02 SSH pins and restore rehearsal` в CI **не получает доступ к реальным дампам**. Она генерирует фиктивные PostgreSQL 16 и 17 с тестовыми таблицами, запускает наш backup, восстанавливает оба архива во временный Docker и проверяет, что намеренно повреждённый архив отвергается. Отдельный job тестирует host key, неправильный порт, неверный fingerprint и несколько конфликтующих ключей.

## 4. Что осталось вручную: GitHub branch governance

Проверено: `main` сейчас **не protected**. Через доступный GitHub-инструмент можно править код и PR, но включение branch protection/ruleset для владельца репозитория этим инструментом не поддержано. Поэтому **настройка не выполнена** и остаётся блокирующим действием владельца.

В GitHub: **Settings → Rules → Rulesets** (или Branch protection), создать активный ruleset для `main`: запрещён force-push и удаление, изменение только через PR, минимум 1 независимый review, требуются зелёные проверки для затронутых областей, запрет обхода для обычных участников, linear history/отсутствие merge при конфликте. Для sensitive workflow/config изменений использовать CODEOWNERS и обязательный review от владельцев инфраструктуры. Зафиксировать rollback/tag и branch ruleset результат документально.

Не объединять всю цепочку ARCH-01–11 одним непроверенным коммитом. PR #133–#145 требуют последовательной интеграции и проверки миграций на копиях БД. Сам этот ARCH-02 PR базируется на текущем `main` и не включает сборщики/Intelligence.

## 5. Отдельные локальные источники (на ноутбуке)

`x-collector/scripts/backup-windows.ps1` уже делает custom-format PostgreSQL backup с TOC-проверкой, а `tg-collector/scripts/backup.sh` и `restore-check.sh` предусматривают контроль restore в явно выделенную БД. Перед любой реальной интеграцией ARCH-08 надо **отдельно** провести локальный PostgreSQL restore X/TG, не в prod.

Для Blockchain SQLite нельзя просто скопировать `.sqlite` при активном WAL: используйте поддерживаемый SQLite online backup (`sqlite3 .backup` / `VACUUM INTO` с проверенными ограничениями) при сохранении единого консистентного snapshot и проверьте восстановление на отдельной копии. Этот ARCH-02 PR **не создаёт** новые Blockchain backups и не переносит ноутбучные сборщики на сервер.

## 6. Критерии завершения ARCH-02

- [ ] Новый GitHub Secrets fingerprint внесён и независимо сверен владельцем;
- [ ] `SSH connection check` пройден на реальном сервере (без отключения pinning);
- [ ] CI на последнем коммите ARCH-02 зелёный;
- [ ] Реальные product/admin dumps и **восстановление обоих** проверены на доверенном отдельном Docker;
- [ ] Offsite encrypted copy и retention введены; отдельные backups X/TG/Blockchain проверены на ноутбуке;
- [ ] Для `main` включены обязательные protection ruleset и reviews;
- [ ] Согласован порядок зависимых PR, миграций, zero-data-loss rollback и восстановление после ошибок.

До выполнения чеклиста **ARCH-02 не считать закрытым**, даже при успешных CI-тестах с синтетическими данными.


## 7. Operator recovery evidence and release-trigger correction — 2026-10-24

**Current, independently verified GitHub evidence (do not confuse image publication with deployment):**

- [POTAPoff backup run 39389328246](https://github.com/vyborovamaria3-maker/claude-project/actions/runs/39389328246), 2026-10-20: **FAILED** in `Create database backup`; job log reports `Host key verification failed` and an offending previously stored ECDSA key. No successful production backup/restore after that was established by this audit.
- [POTAPoff production deploy run 39209623066](https://github.com/vyborovamaria3-maker/claude-project/actions/runs/39209623066), 2026-10-19: **FAILED** at `Upload deployment configuration`, with the same SSH trust error. No newer successful production deployment was found in workflow-run listings during the 2026-10-24 audit.
- [POTAPoff release images run 40082327583](https://github.com/vyborovamaria3-maker/claude-project/actions/runs/40082327583), 2026-10-24: **SUCCESS** for main SHA `e9231d0228723e9eb337a728008d161146ca03c8`. This publishes SHA-tagged build artifacts; **it does not show production was deployed**.
- `main` returned `protected:false`. Repository administrator must configure branch protection or rulesets separately ([#170](https://github.com/vyborovamaria3-maker/claude-project/issues/170)); this repository code change **cannot** install those settings.

**Safe operator sequence (requires verified host ownership and access; NOT executed by this audit):**

1. Using a trusted cloud provider console (NOT the SSH connection displaying the warning), verify the host identity, intended DNS/IP/port, and whether a planned host-key rotation or server rebuild occurred. Treat an unexplained changed SSH host key as a potential incident and investigate before proceeding.
2. On that trusted console, read the exact host public key and calculate `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256`. Compare against a separately trusted record. Do not use `ssh-keyscan` as evidence of authenticity or disable `StrictHostKeyChecking`.
3. Only after the operator confirms a legitimate rotation, update **both** scoped GitHub Secrets `SERVER_SSH_KNOWN_HOSTS` (correct `[hostname]:port` format when port is not 22) and `SERVER_SSH_HOST_KEY_SHA256`. Remove the stale conflicting key from the secret contents; do not blindly delete all SSH trust entries.
4. Run `SSH connection check` manually on `main`. Capture run URL and sanitized result; verify it uses the pinned SSH helper and the approved target.
5. Run `POTAPoff backup` manually. Check its exit code and location of a completed, checksum-verified backup (no paths, credentials or archive contents in public issue comments).
6. On the trusted host, run `verify-backup-restore.sh` against the approved completed backup. It restores into a *disposable no-network Docker* PostgreSQL instance, not into production. Preserve a sanitized checksum/row-count/result summary, and additionally cover independent X/TG PostgreSQL and chain SQLite stores; these are **not** backed up by the POTAPoff server workflow automatically.
7. Only then consider a controlled deployment using an exact reviewed main SHA with a documented rollback, current Security Gates, and a production smoke test. Verify which `workflow_run` triggers/approvals actually fired; a successful `POTAPoff release images` workflow is not permission to claim deployment succeeded.

**Scoped prevention change:** the release-images workflow now ignores **documentation-only pushes** under `docs/**` and `**/*.md(x)`. A mixed docs + code/config/workflow push still triggers the existing main/CI/image gates. `workflow_dispatch` remains available for an explicitly authorized main release. This removes unnecessary production image publication from readme/architecture-only merges, but does **not** fix the SSH trust incident or restore backups by itself.

**Required outcome:** [#172](https://github.com/vyborovamaria3-maker/claude-project/issues/172) stays OPEN until real backup **and restore** evidence exists; do not close [#175](https://github.com/vyborovamaria3-maker/claude-project/issues/175) based only on synthetic CI or published images.
