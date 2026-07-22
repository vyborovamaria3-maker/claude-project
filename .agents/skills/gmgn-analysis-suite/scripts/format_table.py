from __future__ import annotations

import csv
import sys


def main() -> int:
    reader = csv.DictReader(sys.stdin)
    rows = list(reader)
    if not rows:
        return 0

    headers = reader.fieldnames or []
    widths = {h: len(h) for h in headers}
    for row in rows:
        for h in headers:
            widths[h] = max(widths[h], len(str(row.get(h, ""))))

    def fmt_row(values):
        return "| " + " | ".join(str(values.get(h, "")).ljust(widths[h]) for h in headers) + " |"

    print(fmt_row({h: h for h in headers}))
    print("| " + " | ".join("-" * widths[h] for h in headers) + " |")
    for row in rows:
        print(fmt_row(row))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
