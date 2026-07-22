# Changelog

## Added
- Created `gmgn-market-workflow` as the umbrella GMGN analysis skill.
- Created `gmgn-pumpfun-data` for Pump.fun extraction and monitoring.
- Created `gmgn-analysis-suite` as the broad project-level GMGN analysis skill.
- Created `gmgn-market-intel`, `gmgn-wallet-intel`, and `gmgn-launch-intel` as narrow GMGN skills.
- Created `web-product-workflow` for architecture, scraping, and React UI.
- Added `SKILLS_INDEX.md`, `MASTER_SKILLS_INDEX.md`, and `SKILLS_DASHBOARD.md`.
- Added `SKILLS_AUDIT_REPORT.md`.

## Updated
- Imported GMGN marketplace skills into `.agents/skills`.
- Removed unsupported `argument-hint` frontmatter from project-layer GMGN skills.
- Fixed `impeccable` frontmatter so it validates locally.
- Synced `skills-lock.json` with the new local skills.
- Added table and JSON helper templates for GMGN analysis output.
- Added real local wrapper scripts for GMGN market, wallet, and execution flows.

## Validated
- All skills in `.agents/skills` validate successfully.
- `impeccable` validates successfully in the global skill store.
