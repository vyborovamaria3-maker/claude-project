#!/usr/bin/env python3
import csv
import io
import json
import sys


def read_rows():
    data = sys.stdin.read().strip()
    if not data:
        return []
    try:
        parsed = json.loads(data)
        if isinstance(parsed, dict) and "rows" in parsed:
            rows = parsed["rows"]
        else:
            rows = parsed
        if isinstance(rows, list):
            return rows
    except json.JSONDecodeError:
        pass
    return list(csv.DictReader(io.StringIO(data)))


def render_table(rows):
    if not rows:
        return "| no data |"
    headers = list(rows[0].keys())
    out = []
    out.append("| " + " | ".join(headers) + " |")
    out.append("| " + " | ".join(["---"] * len(headers)) + " |")
    for row in rows:
        out.append("| " + " | ".join(str(row.get(h, "")) for h in headers) + " |")
    return "\n".join(out)


if __name__ == "__main__":
    print(render_table(read_rows()))
