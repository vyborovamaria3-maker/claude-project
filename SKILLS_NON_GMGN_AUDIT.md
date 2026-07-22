# Non-GMGN Skills Audit

## Scope

- Project skills in `.agents/skills`
- Non-GMGN skills only

## Findings

### Kept

- `web-product-workflow`

### Rationale

- The skill is directly relevant to this repository.
- It covers site architecture, scraping, and React UI composition.
- It is still useful for the ongoing `solana-launcher` work.

## No removals

- No non-GMGN skill was deleted.
- There were no obvious stale or duplicate non-GMGN project skills to remove.

## Notes

- GMGN coverage now exists as:
  - `gmgn-analysis-suite`
  - `gmgn-market-intel`
  - `gmgn-wallet-intel`
  - `gmgn-launch-intel`
  - plus the existing focused GMGN skills
- If you later want a stricter cleanup pass, we can compare each non-GMGN skill against actual repo usage and remove only the ones that are not referenced.

