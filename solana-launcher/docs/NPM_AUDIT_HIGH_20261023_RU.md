# npm audit: high triage — 23.10.2026

Исходные 30 записей — пакеты и их уязвимые зависимости, а не 30 независимых CVE.
Их шесть первичных причин: toml, braces, ip-address, postcss-selector-parser,
stream-json и uuid. Проверка относится к solana-launcher, не ко всем npm-проектам репозитория.

## Изменения и результат

Существующий override toml повышен с ^5.0.0 до точного 5.0.1; lockfile меняет только
toml 5.0.0 -> 5.0.1. Это совместимый patch, закрывающий три DoS advisories:
[array-of-tables](https://github.com/advisories/GHSA-4qx8-w7c3-pj3p),
[dotted keys](https://github.com/advisories/GHSA-9j65-hcg3-gc64),
[integer literals](https://github.com/advisories/GHSA-9qmh-m7c6-f92p).
Anchor разрешает именно этот parser; API Anchor и его версия не менялись.

Аудит: total 30 -> 29, high 9 -> 7, moderate 21 -> 22, critical 0 -> 0.
toml удалён из advisories, Anchor понижен с high до moderate из-за отдельной
неисправленной цепочки Solana/web3 -> jayson. Поэтому total уменьшился только на один.

Семь оставшихся high: braces, micromatch, chokidar, fast-glob, tailwindcss,
@next/eslint-plugin-next, eslint-config-next. Все идут от одной причины
[braces <=3.0.3](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).
В registry последняя версия 3.0.3; advisory не указывает исправленную версию.
Предлагаемые npm downgrade Next ESLint до 14.x и major Tailwind 4 не являются
совместимым patch. Они не применялись. Уязвимость не скрывалась исключениями аудита.
Цепочки относятся к ESLint/Tailwind tooling; прямых импортов этих glob/parser
пакетов в app/lib/components не найдено. Это не доказательство отсутствия любого
пути эксплуатации: риск остаётся открытым до upstream fix или отдельной миграции.

Moderate: Solana/Anchor/wallet/Lightprotocol в основном наследуют jayson -> uuid /
stream-json; отдельно остаются ip-address и PostCSS selector parser. Обновление
SDK/парсеров или major-миграции требуют отдельных контрактных проверок. В этой
задаче менялись только совместимые исправления high; массового audit fix не было.

## Разбор всех исходных 30 записей

| Пакет | Было | Сейчас | Первичная причина |
|---|---|---|---|
| @coral-xyz/anchor | high | moderate | stream-json, uuid, toml |
| @coral-xyz/borsh | moderate | moderate | stream-json, uuid |
| @lightprotocol/compressed-token | moderate | moderate | stream-json, uuid |
| @lightprotocol/stateless.js | moderate | moderate | stream-json, uuid |
| @next/eslint-plugin-next | high | high | braces |
| @solana-mobile/mobile-wallet-adapter-protocol-web3js | moderate | moderate | stream-json, uuid |
| @solana-mobile/wallet-adapter-mobile | moderate | moderate | stream-json, uuid |
| @solana/buffer-layout-utils | moderate | moderate | stream-json, uuid |
| @solana/spl-token | moderate | moderate | stream-json, uuid |
| @solana/spl-token-group | moderate | moderate | stream-json, uuid |
| @solana/spl-token-metadata | moderate | moderate | stream-json, uuid |
| @solana/wallet-adapter-base | moderate | moderate | stream-json, uuid |
| @solana/wallet-adapter-phantom | moderate | moderate | stream-json, uuid |
| @solana/wallet-adapter-react | moderate | moderate | stream-json, uuid |
| @solana/wallet-standard-wallet-adapter-base | moderate | moderate | stream-json, uuid |
| @solana/wallet-standard-wallet-adapter-react | moderate | moderate | stream-json, uuid |
| @solana/web3.js | moderate | moderate | stream-json, uuid |
| braces | high | high | braces |
| chokidar | high | high | braces |
| eslint-config-next | high | high | braces |
| fast-glob | high | high | braces |
| ip-address | moderate | moderate | ip-address |
| jayson | moderate | moderate | stream-json, uuid |
| micromatch | high | high | braces |
| postcss-nested | moderate | moderate | postcss-selector-parser |
| postcss-selector-parser | moderate | moderate | postcss-selector-parser |
| stream-json | moderate | moderate | stream-json |
| tailwindcss | high | high | braces, postcss-selector-parser |
| toml | high | исправлено | toml |
| uuid | moderate | moderate | uuid |

## Регрессии и ограничения

Новый security suite проверяет Anchor-compatible TOML config, 20000 array tables,
25000 segments dotted key/table path и длинные integer literals четырёх оснований.
Только искусственные данные; каждый процесс ограничен 128 MiB heap и 5 секундами.
5/5 тестов прошли. Suite подключён к npm run security:test.
6/6 collector keyring/UI/publisher compatibility tests прошли.
Полный security suite прошёл; lint: 0 errors, 368 прежних warnings.
analysis:test, production build и TypeScript прошли. Production Playwright smoke:
6 PASS, 0 FAIL, без hydration/runtime ошибок; 1 внешний запрос заблокирован,
API запросов на проверенной публичной странице не было. Smoke server остановлен.

Рабочие БД/ключи не читались и не менялись. PostgreSQL не запускался; SQL и collector
dependencies не менялись. Merge и реальные X действия не выполнялись.
Логи: audit-high-before/after.json, audit-high-tree.txt, audit-high-install.log,
audit-high-security.log, audit-high-lint.log, audit-high-build.log,
audit-high-collector-compat.log, audit-high-playwright.log.
