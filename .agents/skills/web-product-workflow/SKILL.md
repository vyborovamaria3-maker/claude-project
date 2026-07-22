---
name: web-product-workflow
description: Plan and build web product work across site architecture, web scraping, and React UI components. Use when designing information architecture or page structure, extracting data from websites, or implementing reusable React components and UI systems.
---

# Web Product Workflow

## Overview

Use this skill when the task spans one of these web-product areas:

- Site architecture: page hierarchy, navigation, IA, sitemap, user flows, landing-page structure, content blocks
- Web scraping: page discovery, extraction strategy, pagination, rate limits, anti-bot handling, cleanup of noisy HTML
- React UI: reusable components, design-to-code, responsive layouts, state, props, composition, styling systems

## Style Direction

- Favor intentional, distinctive product thinking over generic app patterns.
- Treat architecture as narrative structure, not just navigation.
- Treat scraping as data engineering, not just selector hunting.
- Treat React UI as a component system, not a one-off screen.
- When the user asks for design taste, lean toward bold hierarchy, clear rhythm, and purposeful spacing.

## Workflow

1. Classify the request
   - Architecture work asks for structure, hierarchy, or content organization.
   - Scraping work asks for data extraction, site crawling, or collection pipelines.
   - React UI work asks for components, screens, design systems, or frontend implementation.

2. Identify the output shape
   - Architecture: sitemap, IA map, wireframe outline, content model, page-by-page plan.
   - Scraping: selectors, crawl plan, data schema, parsing notes, extraction code.
   - React UI: component tree, props, state, layout rules, styling tokens, implementation code.

3. Prefer the smallest useful artifact
   - If the user needs direction, produce a concise plan.
   - If the user needs implementation, produce code or component structure.
   - If the user needs both, start with the plan and then implement.

## Templates

### Sitemap

Use this when the task is architectural:

```text
Goal:
Audience:
Primary journeys:
Top-level sections:
- ...

Page map:
- Home
- ...

Key content blocks:
- ...

Open questions:
- ...
```

### Scraper Spec

Use this when the task is extraction:

```text
Source:
Target fields:
Page types:
Access method:
Pagination:
Anti-bot / login constraints:
Selector or request strategy:
Normalization rules:
Deduplication key:
Failure handling:
```

### React Component Spec

Use this when the task is UI implementation:

```text
Component name:
Purpose:
Variants:
Props:
State:
Composition:
Responsive behavior:
Accessibility:
Styling approach:
```

## Site Architecture

- Start from user goals and primary journeys.
- Define top-level sections before page details.
- Keep navigation shallow unless the content model needs depth.
- Convert vague requests into a clear information hierarchy.
- Include responsive behavior when the architecture affects mobile vs desktop layout.

## Web Scraping

- Inspect the target site structure before writing extraction logic.
- Prefer stable selectors and avoid fragile class-name dependencies when possible.
- Handle pagination, lazy loading, nested content, and duplicate records explicitly.
- Normalize extracted fields into a predictable schema.
- Flag login, consent, rate-limit, or anti-bot constraints early.
- Prefer a scraper spec before code when the site is unfamiliar.
- If data is available in network responses, prefer those over DOM scraping.
- Use browser automation only when direct fetches are insufficient.
- Keep raw payload capture separate from parsed output.

For deeper extraction heuristics, selector strategy, and retry guidance, see [references/scraping.md](references/scraping.md).

## React UI Components

- Build components from reusable primitives.
- Separate layout, state, and presentation when it keeps the API clean.
- Design props for composition, not one-off use.
- Keep responsive behavior explicit.
- Match the implementation to the existing stack and styling approach in the repo.
- Start from a component spec when the UI is non-trivial.
- Keep styling tokens centralized when the project already uses a design system.
- Prefer accessible semantics first, then polish visuals.

For component API patterns, responsive layout heuristics, and design-to-code guidance, see [references/react-ui.md](references/react-ui.md).

## When unsure

- Ask for the target site, the data fields to extract, or the component examples before building.
- If the task crosses all three areas, solve in this order: architecture first, scraping second, UI last.

## Production Checklist

- Confirm the target stack before writing implementation details.
- Identify the minimum viable output before expanding scope.
- Verify responsive behavior for mobile and desktop.
- Make data contracts explicit for both scraping and UI props.
- Note risks early: rate limits, authentication, flaky selectors, or unclear UX.
- Prefer reusable structure over hard-coded one-offs.
