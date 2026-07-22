from __future__ import annotations

import json
import sys


def main() -> int:
    data = json.load(sys.stdin)
    if isinstance(data, dict):
        json.dump(data, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
        return 0

    json.dump({"rows": data}, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
