# Skills Audit Report

## Scope
- Project layer: `.agents/skills`
- Global layer: `~/.codex/skills`
- GMGN marketplace skills imported from `GMGNAI/gmgn-skills`
- Local project skills created for this repository

## Findings

### Green
- `gmgn-market-workflow` is valid and available in `.agents/skills`.
- `gmgn-pumpfun-data` is valid and available in `.agents/skills`.
- `web-product-workflow` is valid and available in `.agents/skills`.
- `impeccable` now validates successfully after removing unsupported frontmatter fields.
- `skills-lock.json` includes the local project skills with hashes.
- `SKILLS_INDEX.md` and `MASTER_SKILLS_INDEX.md` document usage.

### Fixed
- Removed unsupported `argument-hint` frontmatter from the project-layer GMGN marketplace skills.
- Restored clean YAML formatting after the earlier sync step.
- Removed unsupported `version`, `user-invocable`, and `argument-hint` frontmatter from `impeccable`.

### Residual notes
- Upstream GMGN skills in the source repo may still use richer metadata than the local validator accepts, but the project-layer copies now validate.
- The project still has other unrelated skills outside GMGN; they were not modified unless they affected this audit.

## Validation
- All skills currently in `.agents/skills` validate successfully.
- Project skill copies are synchronized and ready for use.
- Global non-GMGN skills were audited; `impeccable` was the only one that required a fix.
