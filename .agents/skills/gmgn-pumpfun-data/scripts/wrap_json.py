#!/usr/bin/env python3
import json
import sys


def main():
    data = sys.stdin.read().strip()
    payload = json.loads(data) if data else {}
    if isinstance(payload, list):
        payload = {"rows": payload}
    if "source" not in payload:
        payload["source"] = "gmgn"
    if "scope" not in payload:
        payload["scope"] = "pumpfun"
    print(json.dumps(payload, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
