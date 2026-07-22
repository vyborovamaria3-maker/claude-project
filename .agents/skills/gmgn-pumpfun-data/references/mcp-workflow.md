# MCP Workflow

## Use this path when data comes from Solana tools

1. Call the relevant Solana MCP tool to fetch account, token, signature, or transaction data.
2. Convert the result into the common Pump.fun schema.
3. Use `scripts/format_markdown_table.py` for chat-friendly tables.
4. Use `scripts/wrap_json.py` for machine-friendly JSON.

## Suggested tool mapping

- Address history -> wallet activity, recent trades, token account changes
- Transaction parsing -> event timeline, swaps, transfers, mint actions
- Account info -> ownership, balances, and token account context
- Token supply -> mint size and circulating context

## Operating rule

- Keep MCP source data separate from the rendered output so downstream checks can reuse the raw payload.
