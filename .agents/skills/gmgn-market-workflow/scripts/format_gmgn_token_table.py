#!/usr/bin/env python3
import json
import sys


FIELDS = [
    ("name", "name"),
    ("symbol", "symbol"),
    ("address", "address"),
    ("price", "price"),
    ("price_change_percent5m", "5m%"),
    ("volume", "volume"),
    ("liquidity", "liquidity"),
    ("market_cap", "mcap"),
    ("holder_count", "holders"),
    ("top_10_holder_rate", "top10"),
    ("launchpad_platform", "launchpad"),
]


def row_value(row, key):
    value = row.get(key, "")
    if isinstance(value, float):
        return f"{value:.6g}"
    return str(value)


def main():
    payload = json.load(sys.stdin)
    rows = payload.get("data", {}).get("rank", payload.get("rows", payload))
    if not isinstance(rows, list):
        rows = []
    headers = [label for _, label in FIELDS]
    print("| " + " | ".join(headers) + " |")
    print("| " + " | ".join(["---"] * len(headers)) + " |")
    for row in rows:
        print("| " + " | ".join(row_value(row, key) for key, _ in FIELDS) + " |")


if __name__ == "__main__":
    main()
