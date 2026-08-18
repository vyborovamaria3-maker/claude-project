#!/usr/bin/env python3
"""Fail closed on common committed-secret patterns without printing secret values."""

from __future__ import annotations

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
    Rule("openai-style-key", re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b")),
    Rule("telegram-bot-token", re.compile(r"\b\d{6,12}:[A-Za-z0-9_-]{30,}\b")),
    Rule("helius-api-key", re.compile(r"api-key=[A-Za-z0-9_-]{20,}", re.IGNORECASE)),
]

PLACEHOLDERS = (
    "YOUR_API_KEY",
    "YOUR_TOKEN",
    "your_api_key",
    "your_token",
    "your_bot_token",
    "example.com",
    "ChangeMe",
)

TEXT_SUFFIXES = {
    ".env", ".example", ".ini", ".json", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx",
    ".py", ".yml", ".yaml", ".toml", ".md", ".txt", ".sh", ".conf", ".properties",
}


def is_placeholder(line: str) -> bool:
    return any(marker in line for marker in PLACEHOLDERS)


def scan_line(path: str, line: str, findings: set[tuple[str, str]]) -> None:
    if is_placeholder(line):
        return
    for rule in RULES:
        if rule.pattern.search(line):
            findings.add((path, rule.name))


def scan_current(findings: set[tuple[str, str]]) -> None:
    output = subprocess.check_output(["git", "ls-files", "-z"])
    for raw in output.split(b"\0"):
        if not raw:
            continue
        path = raw.decode("utf-8", errors="replace")
        file_path = Path(path)
        if not file_path.is_file():
            continue
        if file_path.suffix.lower() not in TEXT_SUFFIXES and ".env" not in file_path.name:
            continue
        try:
            with file_path.open("r", encoding="utf-8", errors="ignore") as handle:
                for line in handle:
                    scan_line(path, line, findings)
        except OSError:
            continue


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


def main() -> int:
    findings: set[tuple[str, str]] = set()
    scan_current(findings)
    scan_history(findings)
    if findings:
        print("Potential committed secrets detected. Values are intentionally redacted.", file=sys.stderr)
        for path, kind in sorted(findings):
            print(f"- {path}: {kind}", file=sys.stderr)
        return 1
    print("SECRET_SCAN_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
