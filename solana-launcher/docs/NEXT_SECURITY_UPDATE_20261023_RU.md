# Next.js security update — 23.10.2026

Установленный Next.js 16.4.0 попадал под три advisories: GHSA-673q-mjm6-r5xr
(RCE в use cache), GHSA-2464-fhr4-w9xw (SVG Image Optimization / librsvg RCE)
и GHSA-p3m5-59mp-jv5r (Server Actions DoS).
Официальный бюллетень: https://nextjs.org/blog/nextjs-security-update-october-14-2026
Исправления выпущены в 16.4.1; выбран доступный стабильный patch 16.4.2.
Этот Next поддерживает текущие React/React DOM 18.3.1 и Node >=20.9.

## Изменения

- next и eslint-config-next зафиксированы на 16.4.2; обновлены соответствующие
  env/SWC/ESLint пакеты lockfile. Major migration не выполнялась.
- sharp зафиксирован на 0.35.5 — безопасный минимум из бюллетеня. Lockfile уже
  содержал эту версию; прежний диапазон package.json разрешал также 0.35.4.
- Применён обычный npm install --legacy-peer-deps --ignore-scripts, как требуется
  существующему дереву peer dependencies. Массового npm audit fix не было.

## Проверки

- npm audit: next и sharp отсутствуют в vulnerabilities; critical 1 -> 0.
  Общий backlog 31 -> 30 (21 moderate, 9 high). Это не «нулевой аудит» всего дерева.
- npm run security:test: PASS, включая SAFE_XLSX_SMOKE_OK.
- npm run lint: PASS, 0 errors, 368 warnings; исходный код приложения не менялся.
- npm run build: analysis:test, production compilation, TypeScript и prerender
  прошли с первого раза на 16.4.2; SecurityFatalError не возник.
- 6 collector keyring/UI/publisher compatibility tests: PASS.
- 6 production Playwright smoke assertions: PASS (HTTP 200, main h1, CSP nonce,
  запрет unsafe-eval, nosniff/SAMEORIGIN, отсутствие runtime/hydration ошибок).
  API замоканы, внешние browser requests блокируются. Server env изолирован;
  существующие env-файлы не загружаются, рабочие ключи/БД не используются.

Полные collector/PostgreSQL наборы не повторялись: их код и зависимости не менялись;
их предыдущая приёмка — 387/387 unit, 13/13 native PG. SQL/migrations не затронуты.
Рабочие БД/ключи, реальные X действия и merge не использовались. Smoke server остановлен.
Предупреждение о будущем снятии поддержки React 18 в Next 17 остаётся; это отдельная
major migration. Локальные логи и подробный отчёт находятся в outputs/Next-security-update.md.
