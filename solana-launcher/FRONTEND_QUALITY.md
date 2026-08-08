# POTAPoff Frontend Quality Baseline

This baseline adapts the useful parts of the Front-End-Web-Development-Resources collection to the POTAPoff stack (Next.js, React, Tailwind, Playwright).

## Required on every frontend PR

- TypeScript typecheck and production Next.js build.
- Responsive smoke at 320, 390, 430 and 768 CSS pixels.
- No page-level horizontal overflow on covered routes.
- No browser `pageerror` and no HTTP 4xx/5xx for covered routes.
- Mobile inputs stay at 16px or larger to avoid iOS auto-zoom.
- Mobile navigation works by touch and keyboard; Escape closes modal navigation and focus is restored.
- Visible buttons, links and dialogs have accessible names.
- Images have `alt`; positive `tabindex` is forbidden.
- Axe WCAG 2.0/2.1 A/AA scan has no critical or serious violations.
- Chromium, Firefox and WebKit smoke passes on mobile and desktop.
- Lighthouse minimums: accessibility 90, best practices 85, SEO 80, performance 65.
- `prefers-reduced-motion` is respected.

## Release checks

Before a major public release, manually inspect at least one real iOS Safari device and one Android Chrome device. BrowserStack/LambdaTest/Sizzy/Responsinator are optional helpers when real hardware is unavailable.

Review Lighthouse reports and responsive screenshots uploaded by CI. Treat performance regressions as actionable even when they remain above the minimum gate.

## Performance and asset rules

- Prefer Next.js image optimization for product/static imagery when practical.
- Avoid adding large decorative raster assets when CSS/SVG can provide the same result.
- Lazy-load non-critical media and heavy widgets.
- Keep animation purposeful and compatible with reduced-motion preferences.
- Avoid introducing a second CSS framework or duplicate component system.

## Existing stack to keep

- Tailwind CSS for layout/design utilities.
- Lucide React for icons.
- Framer Motion only where animation adds product value.
- Playwright for browser/device automation.

## Deliberately not adopted from the resource collection

Do not add Bootstrap, Bulma, Semantic UI, Materialize, jQuery-era plugins, icon-font libraries, or extra animation frameworks merely because they appear in the resource list. They overlap with the existing stack and increase bundle size, CSS specificity conflicts, maintenance cost and visual inconsistency.

## External reference categories used

The resource collection was mined primarily for: A11y/Axe, colour contrast, Lighthouse, BrowserStack/LambdaTest/cross-browser testing, Responsinator/Sizzy responsive testing, W3C-style markup discipline, web performance tooling, Front-End Checklist concepts, image optimization and reduced-motion/accessibility guidance.
