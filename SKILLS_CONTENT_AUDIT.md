# Content Audit

## Overlaps and recommended grouping

### GMGN market skills
- `gmgn-market` and `gmgn-market-workflow` overlap on discovery and token analysis.
- Recommendation: use `gmgn-market` for direct CLI-specific market commands and `gmgn-market-workflow` for combined analysis and formatting.

### GMGN token/wallet skills
- `gmgn-token`, `gmgn-portfolio`, and `gmgn-track` partially overlap in wallet/token intelligence.
- Recommendation: use `gmgn-token` for asset-level due diligence, `gmgn-portfolio` for wallet performance, and `gmgn-track` for live flow signals.

### Pump.fun skills
- `gmgn-pumpfun-data` and `gmgn-market-workflow` both touch Pump.fun market data.
- Recommendation: use `gmgn-pumpfun-data` when the task is export/monitoring/extraction, and `gmgn-market-workflow` when the task is broader GMGN analysis.

### UI / design skills
- `impeccable`, `taste-skill`, `redesign-skill`, `stitch-skill`, `brandkit`, `minimalist-skill`, and `brutalist-skill` all cover style or redesign direction.
- Recommendation: use `impeccable` for highest-craft UI polish, `taste-skill` for aesthetic direction, `redesign-skill` for explicit redesign tasks, and `brandkit` when brand rules matter.

### Frontend implementation skills
- `web-product-workflow`, `image-to-code-skill`, `figma-implement-design`, `playwright`, and `screenshot` form the implementation loop.
- Recommendation: use `web-product-workflow` for planning and implementation, `figma-implement-design` when the source is Figma, and `playwright` / `screenshot` for verification.

## Consolidation opportunities
- Keep `gmgn-market-workflow` as the umbrella GMGN skill.
- Keep `gmgn-pumpfun-data` as the Pump.fun-specialized sibling.
- Keep `web-product-workflow` as the single project skill for site architecture, scraping, and React UI.
- Prefer `impeccable` as the canonical design-polish skill and route related design work there first.
