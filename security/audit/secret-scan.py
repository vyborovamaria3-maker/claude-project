#!/usr/bin/env python3
"""Detect common committed-secret patterns without printing secret values."""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Rule:
    name: str
    pattern: re.Pattern[str]


RULES = [
    Rule("private-key", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----")),
    Rule("aws-access-key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    Rule("github-token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}\b")),
    Rule("api-key-sk-prefix", re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b")),
    Rule("telegram-bot-token", re.compile(r"\b\d{6,12}:[A-Za-z0-9_-]{30,}\b")),
    Rule("helius-api-key", re.compile(r"api-key=[A-Za-z0-9_-]{20,}", re.IGNORECASE)),
    Rule("jwt-bearer", re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b")),
]

PLACEHOLDERS = (
    "your_api_key",
    "your_token",
    "your_bot_token",
    "replace-with-",
    "changeme",
)

TEXT_SUFFIXES = {
    ".env", ".example", ".ini", ".json", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx",
    ".py", ".yml", ".yaml", ".toml", ".md", ".txt", ".sh", ".conf", ".properties",
}


def is_placeholder_match(value: str) -> bool:
    normalized = value.lower()
    return any(marker in normalized for marker in PLACEHOLDERS)


def scan_line(path: str, line: str, findings: set[tuple[str, str]]) -> None:
    # Placeholder text elsewhere on the line must never suppress a real match.
    # Only the exact matched token may be treated as an example value.
    for rule in RULES:
        for match in rule.pattern.finditer(line):
            if not is_placeholder_match(match.group(0)):
                findings.add((path, rule.name))
                break


def scan_current(findings: set[tuple[str, str]]) -> None:
    output = subprocess.check_output(["git", "ls-files", "-z"])
    for raw in output.split(b"\0"):
        if not raw:
            continue
        path = raw.decode("utf-8", errors="replace")
        file_path = Path(path)
        if not file_path.is_file():
            continue
        if file_path.suffix.lower() not in TEXT_SUFFIXES and ".env" not in file_path.name and file_path.name != ".editorconfig":
            continue
        try:
            with file_path.open("r", encoding="utf-8", errors="ignore") as handle:
                for line in handle:
                    scan_line(path, line, findings)
        except OSError:
            continue


def scan_patch(lines: list[str], findings: set[tuple[str, str]]) -> None:
    current_path = "<diff>"
    for line in lines:
        if line.startswith("+++ b/"):
            current_path = line[6:].strip()
            continue
        if not line.startswith("+") or line.startswith("+++"):
            continue
        scan_line(current_path, line[1:], findings)


def scan_diff(base: str, head: str, findings: set[tuple[str, str]]) -> None:
    if not base or not head:
        raise ValueError("--base and --head are required for diff mode")
    output = subprocess.check_output(
        ["git", "diff", "--no-ext-diff", "--no-color", "--unified=0", f"{base}...{head}"],
        text=True,
        encoding="utf-8",
        errors="ignore",
    )
    scan_patch(output.splitlines(), findings)


def scan_history(findings: set[tuple[str, str]]) -> None:
    proc = subprocess.Popen(
        ["git", "log", "--all", "-p", "--no-ext-diff", "--no-color", "--format=commit %H"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="ignore",
    )
    assert proc.stdout is not None
    current_path = "<history>"
    for line in proc.stdout:
        if line.startswith("+++ b/"):
            current_path = line[6:].strip()
            continue
        if not line.startswith("+") or line.startswith("+++"):
            continue
        scan_line(current_path, line[1:], findings)
    stderr = proc.stderr.read() if proc.stderr is not None else ""
    code = proc.wait()
    if code != 0:
        raise RuntimeError(f"git history scan failed with exit code {code}: {stderr.strip()}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("current", "diff", "history"), default="current")
    parser.add_argument("--base", default="")
    parser.add_argument("--head", default="")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    findings: set[tuple[str, str]] = set()
    if args.mode == "current":
        scan_current(findings)
    elif args.mode == "diff":
        scan_diff(args.base, args.head, findings)
    else:
        scan_history(findings)

    if findings:
        print(f"Potential secrets detected in {args.mode} scan. Values are intentionally redacted.", file=sys.stderr)
        for path, kind in sorted(findings):
            print(f"- {path}: {kind}", file=sys.stderr)
        return 1
    print(f"SECRET_SCAN_OK mode={args.mode}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
