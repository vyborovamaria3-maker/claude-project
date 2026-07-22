---
name: ponytail-reuse
description: Reuse-first engineering workflow for minimizing new code. Use when Codex needs to implement, refactor, debug, or design software while aggressively checking YAGNI, existing code, native platform features, installed dependencies, and one-line solutions before writing custom code.
---

# Ponytail Reuse

## Core Rule

Before writing code, climb the reuse ladder and stop at the first sufficient rung:

1. Decide whether the feature is needed at all. Apply YAGNI and preserve current behavior unless the request requires change.
2. Search the codebase for an existing implementation, helper, component, service, schema, or pattern.
3. Prefer the standard library, browser/runtime APIs, shell tools, database features, framework primitives, or native platform behavior.
4. Prefer already installed dependencies over adding new ones.
5. Prefer a one-line or declarative solution when it is clear and maintainable.
6. Only then write the smallest working implementation.

## Workflow

- Inspect local files with `rg`, package manifests, configs, tests, and nearby code before editing.
- State the reuse choice briefly when it affects the design.
- Keep edits narrow and aligned with existing patterns.
- Avoid new abstractions, packages, scripts, or frameworks unless they remove real complexity.
- Treat validation, input handling, error paths, and security checks as required behavior.

## Output

When reporting results, include what was reused, what new code was unavoidable, and what validation was run or could not be run.
