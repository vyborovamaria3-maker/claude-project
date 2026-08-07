# Free testing strategy

The analytics engine must not depend on paid X access during development.

## Level 1 — deterministic fixtures

`DATA_PROVIDER=fixture` reads `fixtures/x-posts.json`. Use it for UI, API, graph, cluster, score and regression tests. Add more campaigns to this file, including organic, coordinated, empty and malformed cases.

## Level 2 — imported datasets

Convert data you are legally allowed to use into the fixture format. Good sources include your own X data export, data contributed by testers, and synthetic datasets. Keep the original source and consent/license in import metadata.

## Level 3 — tiny paid smoke test later

When funding exists, enable one provider with a strict spending limit and cache. Run only a small set of known queries and compare normalized results against fixture snapshots.

## Never store

Passwords, browser cookies, session tokens, private DMs, or another person's private data. Do not build tests around bypassing platform access controls.
