# npm audit: moderate triage — 23.10.2026

Разобраны все 22 moderate solana-launcher; это записи о пакетах/наследуемых цепочках,
а не 22 независимые CVE. Корневые причины: ip-address, uuid, stream-json и
postcss-selector-parser. Запрет major-миграций соблюдён и для транзитивных override.

## Совместимое исправление

ip-address 10.7.3 -> 10.7.4, обычный npm update ip-address с существующим
--legacy-peer-deps и --ignore-scripts. Из зависимостей изменён только один блок
lockfile; package.json/SDK/Next/Tailwind и API приложения не менялись.
Патч закрывает [GHSA-rxp7-6hxx-x8q5](https://github.com/advisories/GHSA-rxp7-6hxx-x8q5).
Оба потребителя (socks и express-rate-limit) разрешают исправленную версию.

Аудит: total 29 -> 28, moderate 22 -> 21, high 7 -> 7, critical 0 -> 0.

## Что нельзя исправить в текущих major

| Цепочка | Установлено / последний текущий major | Исправление | Решение |
|---|---|---|---|
| Solana/Anchor/Lightprotocol/wallet -> web3 -> jayson -> uuid | web3 1.99.0, jayson 4.3.0, uuid 8.3.2 | uuid >=11.1.1, jayson 5 удаляет зависимость | Major override/миграция не выполнялась |
| Те же SDK -> jayson -> stream-json | 1.9.1 | >=3.6.0 либо jayson 5 | Major override не выполнялся |
| Tailwind 3/postcss-nested 6 -> selector-parser | 6.1.4; последняя 6.x — 6.1.5, тоже уязвима | >=7.1.6 | Major override/переход Tailwind 4 не выполнялся |

Последние опубликованные jayson 4.x (4.3.0), uuid 8.x (8.3.2), nested 6.x (6.2.0)
и web3 1.x (1.99.0) не устраняют соответствующие цепочки. Рекомендации npm о
downgrade Lightprotocol или переходе SDK на другой major не применялись.
Обновлять 6.1.4 -> 6.1.5 только ради номера версии нет смысла: advisory охватывает
все selector-parser <7.1.6.

В установленном jayson обнаружены вызовы uuid.v4 (advisory относится к v3/v5/v6
с внешним буфером); это снижает применимость конкретного сценария к этому consumer,
но не устраняет сам уязвимый пакет и не является основанием скрывать audit.
Stream-json используется в stream parser jayson; фактическая достижимость зависит
от выбранного transport. Selector parser здесь идёт через Tailwind tooling;
advisory отличает trusted build input от серверного разбора недоверенного CSS.
Эти ограничения не объявляются доказательством полной недостижимости.

Источники: [uuid](https://github.com/advisories/GHSA-w5hq-g745-h8pq),
[selector parser](https://github.com/advisories/GHSA-rj75-hqrm-r3gf),
[stream-json](https://github.com/advisories/GHSA-mjw6-4jj6-33hc),
[stream filters](https://github.com/advisories/GHSA-528h-pc64-c93x),
[JSONC](https://github.com/advisories/GHSA-hqr4-qq8f-hg3x).

## Все исходные moderate

| Пакет | Сейчас | Корневая причина |
|---|---|---|
| @coral-xyz/anchor | moderate | stream-json, uuid |
| @coral-xyz/borsh | moderate | stream-json, uuid |
| @lightprotocol/compressed-token | moderate | stream-json, uuid |
| @lightprotocol/stateless.js | moderate | stream-json, uuid |
| @solana-mobile/mobile-wallet-adapter-protocol-web3js | moderate | stream-json, uuid |
| @solana-mobile/wallet-adapter-mobile | moderate | stream-json, uuid |
| @solana/buffer-layout-utils | moderate | stream-json, uuid |
| @solana/spl-token | moderate | stream-json, uuid |
| @solana/spl-token-group | moderate | stream-json, uuid |
| @solana/spl-token-metadata | moderate | stream-json, uuid |
| @solana/wallet-adapter-base | moderate | stream-json, uuid |
| @solana/wallet-adapter-phantom | moderate | stream-json, uuid |
| @solana/wallet-adapter-react | moderate | stream-json, uuid |
| @solana/wallet-standard-wallet-adapter-base | moderate | stream-json, uuid |
| @solana/wallet-standard-wallet-adapter-react | moderate | stream-json, uuid |
| @solana/web3.js | moderate | stream-json, uuid |
| ip-address | исправлено | ip-address |
| jayson | moderate | stream-json, uuid |
| postcss-nested | moderate | postcss-selector-parser |
| postcss-selector-parser | moderate | postcss-selector-parser |
| stream-json | moderate | stream-json |
| uuid | moderate | uuid |

## Проверки

4/4 новых ip-address tests: IPv4, IPv6 CIDR/zone, fromByteArray, 500000 percent
characters с четырьмя line terminators через оба фактических consumer resolver.
Дочерние процессы ограничены 64 MiB heap и 3 секундами; сеть не используется.
Suite подключён к security:test. 6/6 collector keyring compatibility tests прошли.
Полный security suite прошёл: 5 TOML + 4 ip-address tests, ошибок нет.
Полный lint: 0 errors, 368 прежних warnings. analysis:test, production build и
TypeScript прошли. Production Playwright smoke: 6 PASS, 0 FAIL; внешний запрос
заблокирован, API-запросов на проверенной публичной странице не было.
Smoke server остановлен. Результаты сохранены в outputs/Audit-moderate-review.md.

Рабочие БД/ключи не читались и не менялись. SQL/collector dependencies не менялись,
PostgreSQL не запускался. Merge и реальные X действия не выполнялись.
7 high от unpatched braces остаются из предыдущего отчёта; audit не подавлялся.
Логи: audit-moderate-before/after.json, audit-moderate-tree.txt,
audit-moderate-install.log, audit-moderate-security.log, audit-moderate-lint.log,
audit-moderate-build.log, audit-moderate-collector-compat.log,
audit-moderate-playwright.log. Registry-версии сохранены в audit-moderate-*.json.
