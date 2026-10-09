# Bounded braces fork

This MIT-licensed fork of micromatch/braces 3.0.3 preserves its API and license.
It fixes GHSA-vfj7-8cjw-p6xm by limiting parser nesting and every recursive AST
walker to 64 levels, including callers supplying an AST directly. The original
maximum input length and range expansion limits remain in force.

Upstream advisory: https://github.com/advisories/GHSA-vfj7-8cjw-p6xm
Regression tests: `node --test security/audit/braces-safe.test.mjs` from repo root.
Remove this fork once an upstream release with equivalent guards is available.
