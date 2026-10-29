"""Subprocess checks never start the server or open/create a database."""

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

RUNNER = Path(__file__).resolve().parents[1] / "scripts" / "run_local.py"


class LocalBackendLauncherTests(unittest.TestCase):
    def check_config(self, content):
        with tempfile.TemporaryDirectory() as directory:
            env_file = Path(directory) / "backend.env"
            env_file.write_text(content, encoding="utf-8")
            env = {
                key: value
                for key, value in os.environ.items()
                if key.upper() in {"PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "VIRTUAL_ENV"}
            }
            result = subprocess.run(
                [sys.executable, str(RUNNER), "--check", "--env-file", str(env_file)],
                cwd=directory,
                env=env,
                capture_output=True,
                text=True,
                timeout=20,
            )
            self.assertFalse((Path(directory) / "must-not-create.db").exists())
            return result

    def test_missing_secret_is_reported_without_secret_values(self):
        result = self.check_config("DATABASE_URL=sqlite+aiosqlite:///must-not-create.db\n")
        self.assertEqual(result.returncode, 2)
        self.assertIn("SECRET_KEY", result.stderr)
        self.assertNotIn("Traceback", result.stderr)

    def test_existing_database_must_be_explicit(self):
        result = self.check_config("SECRET_KEY=" + "test-key-" * 8 + "\n")
        self.assertEqual(result.returncode, 2)
        self.assertIn("DATABASE_URL", result.stderr)

    def test_explicit_valid_config_does_not_start_or_touch_database(self):
        secret = "test-key-" * 8
        result = self.check_config(
            "ENVIRONMENT=test\nSECRET_KEY="
            + secret
            + "\nDATABASE_URL=sqlite+aiosqlite:///must-not-create.db\n"
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("no database connection", result.stdout)
        self.assertNotIn(secret, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
