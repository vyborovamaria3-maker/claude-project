"""Explicit local download of approved sentiment model *safetensors*.

Run manually on the operator's machine. Never imported by collectors or
their background workers; no third-party code execution is enabled.
"""
from __future__ import annotations

import argparse
import re
import sys

from intelligence.nlp.sentiment import MODELS


def run(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Explicitly pre-cache approved sentiment model weights")
    parser.add_argument("--models", nargs="+", choices=tuple(MODELS), required=True,
                        help="models to download; list all three to prepare full routing")
    parser.add_argument("--download", action="store_true",
                        help="actually download public model files to the local HF cache")
    args = parser.parse_args(argv)
    try:
        from huggingface_hub import HfApi, snapshot_download
        api = HfApi()
        for key in args.models:
            spec = MODELS[key]
            revision = api.model_info(spec.repository).sha
            if not re.fullmatch(r"[0-9a-f]{40}", revision):
                raise ValueError("upstream revision was not immutable SHA")
            if args.download:
                snapshot_download(
                    repo_id=spec.repository, revision=revision,
                    allow_patterns=[
                        "*.safetensors", "*.json", "*.txt", "*.model",
                        "vocab.*", "merges.txt", "tokenizer.*",
                    ],
                )
            print(spec.revision_env + "=" + revision)
        return 0
    except Exception:
        print("sentiment model preparation failed; no credentials or remote details printed",
              file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(run())
