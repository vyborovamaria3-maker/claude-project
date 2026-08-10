"""Safe yt-dlp client for YouTube intelligence collection."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from intelligence.errors.exceptions import ProviderError
from intelligence.security.urls import validate_public_url


_ALLOWED_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
}
_VTT_TIMESTAMP_RE = re.compile(r"^\d{2}:\d{2}:\d{2}[\.,]\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}[\.,]\d{3}")


class YouTubeClient:
    def __init__(
        self,
        *,
        executable: str = "yt-dlp",
        timeout_seconds: float = 60.0,
        max_output_bytes: int = 2_000_000,
        subtitle_languages: tuple[str, ...] = ("en", "ru"),
    ) -> None:
        if timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be > 0")
        if max_output_bytes < 1:
            raise ValueError("max_output_bytes must be > 0")
        if not executable.strip():
            raise ValueError("executable must not be empty")
        if not subtitle_languages:
            raise ValueError("subtitle_languages must not be empty")
        self.executable = executable
        self.timeout_seconds = timeout_seconds
        self.max_output_bytes = max_output_bytes
        self.subtitle_languages = subtitle_languages

    @staticmethod
    def validate_youtube_url(url: str) -> str:
        normalized = validate_public_url(url)
        hostname = (urlsplit(normalized).hostname or "").lower()
        if hostname not in _ALLOWED_HOSTS:
            raise ValueError("YouTube provider only accepts youtube.com or youtu.be URLs")
        return normalized

    def available(self) -> bool:
        return shutil.which(self.executable) is not None

    def fetch_metadata(self, url: str) -> dict[str, Any]:
        target = self.validate_youtube_url(url)
        completed = self._run(
            [
                self.executable,
                "--dump-single-json",
                "--skip-download",
                "--no-playlist",
                "--no-warnings",
                target,
            ]
        )
        raw = completed.stdout.encode("utf-8", errors="replace")
        if len(raw) > self.max_output_bytes:
            raise ProviderError("yt-dlp metadata exceeds configured size limit")
        try:
            payload = json.loads(completed.stdout)
        except json.JSONDecodeError as exc:
            raise ProviderError("yt-dlp returned invalid metadata JSON") from exc
        if not isinstance(payload, dict):
            raise ProviderError("yt-dlp returned unexpected metadata")
        return payload

    def fetch_transcript(self, url: str) -> str | None:
        target = self.validate_youtube_url(url)
        with tempfile.TemporaryDirectory(prefix="potapoff-youtube-") as temp_dir:
            output_template = str(Path(temp_dir) / "%(id)s.%(ext)s")
            langs = ",".join(self.subtitle_languages)
            self._run(
                [
                    self.executable,
                    "--skip-download",
                    "--no-playlist",
                    "--no-warnings",
                    "--write-subs",
                    "--write-auto-subs",
                    "--sub-langs",
                    langs,
                    "--sub-format",
                    "vtt",
                    "--output",
                    output_template,
                    target,
                ]
            )
            subtitle_files = sorted(Path(temp_dir).glob("*.vtt"))
            if not subtitle_files:
                return None
            payload = subtitle_files[0].read_bytes()
            if len(payload) > self.max_output_bytes:
                raise ProviderError("YouTube transcript exceeds configured size limit")
            return _vtt_to_text(payload.decode("utf-8", errors="replace")) or None

    def health(self) -> int:
        if not self.available():
            raise ProviderError("yt-dlp executable is not available")
        completed = self._run([self.executable, "--version"])
        if not completed.stdout.strip():
            raise ProviderError("yt-dlp version check returned no output")
        return 0

    def _run(self, args: list[str]) -> subprocess.CompletedProcess[str]:
        if not self.available():
            raise ProviderError("yt-dlp executable is not available")
        try:
            completed = subprocess.run(
                args,
                check=False,
                capture_output=True,
                text=True,
                timeout=self.timeout_seconds,
                shell=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise ProviderError("yt-dlp timed out") from exc
        except OSError as exc:
            raise ProviderError("yt-dlp could not be executed") from exc
        if completed.returncode != 0:
            raise ProviderError("yt-dlp request failed")
        return completed


def _vtt_to_text(value: str) -> str:
    lines: list[str] = []
    previous: str | None = None
    for raw_line in value.splitlines():
        line = raw_line.strip()
        if not line or line == "WEBVTT" or line.startswith("NOTE"):
            continue
        if _VTT_TIMESTAMP_RE.match(line):
            continue
        if line.isdigit():
            continue
        line = re.sub(r"<[^>]+>", "", line).strip()
        if line and line != previous:
            lines.append(line)
            previous = line
    return "\n".join(lines)
