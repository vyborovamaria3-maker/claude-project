# POTAPoff Analysis Tabs + per-source AI — BUILD ONLY

Код уже подготовлен. Не проектировать заново.

## Что уже изменено

- `app/trade/analysis/page.tsx`
  - новый визуальный TabBar;
  - отдельные вкладки Overview / Blockchain / Telegram / X / KOLs / AI;
  - KOL больше не висит на всех вкладках;
  - Blockchain заканчивается своим AI-блоком;
  - KOLs заканчивается своим AI-блоком.

- `components/trade/SocialIntelligencePanel.tsx`
  - Telegram и X больше не выглядят как огромная таблица из дефисов;
  - сверху KPI + evidence cards;
  - полная таблица спрятана в раскрывающийся блок;
  - Telegram заканчивается `AI-анализ Telegram`;
  - X заканчивается `AI-анализ X / Twitter`;
  - Blockchain mode заканчивается `AI-анализ блокчейна`;
  - AI / EE сохраняет полный cross-source AI report;
  - warnings в source tabs фильтруются, чтобы Telegram не показывал ошибки X и наоборот.

- `components/trade/KolAiAnalysis.tsx`
  - отдельный AI output для GMGN KOL / Smart Money evidence.

- `app/api/trade/kols-ai/route.ts`
  - server-only AI route;
  - получает уже собранные KOL / Smart Money сделки;
  - строит структурированный chain snapshot;
  - вызывает существующий MEMECOIN_INTELLIGENCE / Tooken/Qwen backend;
  - секреты на frontend не передаются.

- `scripts/analysis-regression.mjs`
  - regression assertion обновлён под новую tab architecture.

## Что должен сделать Codex

1. Скопировать файлы из этого архива поверх:
   `C:\Users\Рафаил\claude-project\solana-launcher`

2. Ничего не перепроектировать.

3. Не трогать:
   - `GMGN_API_KEY`
   - Docker secrets
   - `/api/trade/kols`
   - рабочий GMGN runtime
   - unrelated project files

4. Выполнить:

```powershell
cd C:\Users\Рафаил\claude-project\solana-launcher
docker compose build frontend
```

5. Если есть TypeScript/build error — исправить только минимальную несовместимость.

6. После успешного build:

```powershell
docker compose up -d --force-recreate frontend nginx
```

7. Smoke test:

- `?tab=overview`
- `?tab=blockchain` — AI block в самом низу
- `?tab=telegram` — AI block в самом низу
- `?tab=twitter` — AI block в самом низу
- `?tab=kols` — AI block в самом низу
- `?tab=ai` — полный cross-source AI / EE

## Не делать

- не возвращать длинную stacked page;
- не объединять Telegram/X обратно;
- не переносить KOL наверх страницы;
- не удалять per-source AI blocks;
- не делать `git reset`;
- не печатать API keys.
