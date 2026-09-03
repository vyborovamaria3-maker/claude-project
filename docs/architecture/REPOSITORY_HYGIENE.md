# Repository Hygiene

## Purpose

Keep ordinary Git history free of local secrets, browser/auth session state, temporary scripts, local databases, editor/extension bundles, arbitrary release archives, vendored dependencies, and oversized tracked files.

## Automated check

Run locally from the repository root:

```bash
npm run hygiene:check
```

`scripts/repository-hygiene.mjs` inspects tracked file paths and file sizes. It intentionally does not inspect file contents, so secret scanning remains a separate security control.

The check rejects tracked:

- real `.env` files while allowing `.example`, `.template`, and `.sample` variants;
- browser/auth state such as `storage-state.json`, `auth-state.json`, and `session-state.json`;
- `tmp-*` files;
- `*.vsix` extension bundles;
- local `*.db`, `*.sqlite`, and `*.sqlite3` databases;
- ZIP archives;
- `node_modules` directories;
- regular files larger than 10 MiB.

## Temporary legacy exception

`POTAPoff-landing-minimal-v3.zip` is temporarily allowlisted because it is an existing tracked legacy release artifact. Do not add more archives to this allowlist. Move the artifact to GitHub Releases, artifact/object storage, or Git LFS when practical, then remove the exception.

## Repository policy

Keep source, configuration templates, fixtures, and reproducible build inputs in Git. Store release bundles and generated artifacts outside ordinary Git history. Never commit real environment files or captured browser/auth state.

## Pre-commit hooks

A `pre-commit` configuration exists at `solana-launcher/pre-commit-config.yaml` (note: **no leading dot** — the `pre-commit` tool does not auto-discover it). Run explicitly with:

```bash
cd solana-launcher && pre-commit run --all-files -c pre-commit-config.yaml
```

CI invokes ruff/mypy directly in three workflows (`full-backtest-audit.yml`, `telegram-intelligence-v19-ci.yml`, `trade-intelligence-quality.yml`) scoped to the `backend` directory.

## W-refs

This document is maintained as part of the architecture audit (W0.10, W1.5, W2.4).
