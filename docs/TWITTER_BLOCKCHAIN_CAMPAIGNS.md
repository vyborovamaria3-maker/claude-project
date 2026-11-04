# Twitter campaigns in blockchain analysis

The existing on-chain analysis now includes a mint-scoped campaign section and a `campaignAssessment` on each final NDJSON event, including cache hits. `/api/trade/token-campaigns?mint=...` uses the application's existing production authorization and reads only saved artifacts; it never invokes a price or AI provider. `&evidence=<hash>` returns the validated, redacted candle proof for that same mint. Changing the mint cancels the previous UI request.

The shared server reader checks the token identity, USD unit, pool membership, completed candles, text hashes, raw-file checksums and snapshot age. Unknown/stale/unconfigured evidence remains explicitly unavailable. Different-token evidence, arbitrary file paths and unexpected provider fields are not forwarded. Price and timing calculations are reconstructed from the supplied candles. A thin 5m candle (<$100 USD volume at either endpoint) is labelled and cannot establish an early-growth signal; higher volume still does not prove execution.

`intelligence/scripts/token-analysis.mjs` receives optional deterministic counts and a compact numeric campaign context. Original campaign posts and the full blockchain archive are not sent to the model. Available counts can be cited only as supplied facts; common ownership, payment, skill and realized PNL are not inferred. Refresh timestamps and UI proof-only changes do not invalidate the model cache. All stored blockchain rows contribute to the separately hashed aggregate, with at most 20 illustrative trades sent to the model.

## Configuration and upgrade

1. Install `x-collector/scripts/author-outcomes/requirements.txt` in the collector's Python environment.
2. Set `AUTHOR_OUTCOMES_DSN` to the collector writer DSN and `AUTHOR_OUTCOMES_DIRECTORY` to its dedicated artifact directory. Run `python worker.py --migrate --backfill`, then supervise `python worker.py` with the existing service manager.
3. Set `AUTHOR_OUTCOMES_DIRECTORY` to the same mounted directory for the web app, intelligence API and admin. The readers need filesystem read access only; do not give the frontend the collector writer DSN.
4. On upgrades, `python worker.py --migrate --once` also verifies legacy Python-canonical proof hashes and writes `.json.sha256` raw-byte sidecars for cross-runtime validation. New price evidence gets both hashes automatically. No historical price is invented or replaced by the current spot price.

The local existing supervisor continues to manage the evaluator and its 15-minute provider rate-limit backoff. This integration creates no second scanner, queue broker or scheduled Codex task. Group refresh remains every five minutes. The admin retains the full group evidence; the blockchain UI shows bounded, explicitly counted excerpts for the selected CA.

## Checks

- `node --test solana-launcher/scripts/token-campaigns.test.mjs`
- `npm --prefix solana-launcher run analysis:test` and strict typecheck
- `npm --prefix intelligence run check`
- `python -m unittest discover -s x-collector/scripts/author-outcomes -p 'test_*.py'`
- Set `AUTHOR_OUTCOMES_TEST_DSN` only to a disposable database to run transactional PostgreSQL lifecycle tests. Test schemas are rolled back; tests never default to the production DSN.
- Full admin suite and the added `Social campaigns and blockchain evidence` workflow run on main; existing intelligence, collector, security and repository checks remain in place.

The source artifacts describe retrospective, incomplete observations. No group count is a manipulation probability, no earliest stored mention proves the first publication anywhere, and no hypothetical return is an author's wallet PNL.
