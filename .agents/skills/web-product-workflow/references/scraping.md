# Scraping

## Extraction checklist

- Identify the source pages and whether content is static or hydrated.
- Determine whether data lives in HTML, embedded JSON, XHR calls, or rendered DOM.
- Capture the minimum stable selector or request that reaches the data.
- Decide whether you need one-off extraction, pagination, or a crawl graph.
- Normalize records early to avoid downstream shape drift.

## Implementation heuristics

- Prefer direct data sources when the site exposes them.
- Use browser automation only when the site requires rendering or interaction.
- Retry gently and respect rate limits.
- Deduplicate by canonical URL, stable IDs, or normalized text signatures.
- Preserve raw payloads when later parsing may change.

## Common failure modes

- Infinite scroll without a termination rule.
- Duplicate rows from repeated page sections.
- Hidden consent dialogs blocking the first render.
- JSON blobs that change structure across page types.
- Overfitting selectors to volatile class names.
