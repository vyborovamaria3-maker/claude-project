from __future__ import annotations

import unittest

from intelligence.security.sanitizer import sanitize_payload, sanitize_text
from intelligence.worker.retry import RetryPolicy


class SanitizerTests(unittest.TestCase):
    def test_text_redacts_common_secret_formats(self) -> None:
        value = (
            "TOKEN : abc123 api key=xyz Authorization Bearer secret-token "
            "cookie=session private_key=keymaterial seed phrase=words"
        )
        sanitized = sanitize_text(value)
        lowered = sanitized.lower()
        self.assertNotIn("abc123", sanitized)
        self.assertNotIn("xyz", sanitized)
        self.assertNotIn("secret-token", sanitized)
        self.assertNotIn("session", sanitized)
        self.assertNotIn("keymaterial", sanitized)
        self.assertNotIn("words", sanitized)
        self.assertGreaterEqual(lowered.count("[redacted]"), 6)

    def test_payload_redacts_sensitive_keys_recursively(self) -> None:
        payload = {
            "username": "alice",
            "api_key": "secret-a",
            "nested": {
                "Authorization": "Bearer secret-b",
                "message": "token=secret-c",
            },
            "items": [{"cookie": "secret-d"}],
        }
        sanitized = sanitize_payload(payload)
        self.assertEqual(sanitized["username"], "alice")
        self.assertEqual(sanitized["api_key"], "[REDACTED]")
        self.assertEqual(sanitized["nested"]["Authorization"], "[REDACTED]")
        self.assertNotIn("secret-c", sanitized["nested"]["message"])
        self.assertEqual(sanitized["items"][0]["cookie"], "[REDACTED]")

    def test_non_secret_text_is_preserved(self) -> None:
        value = "repository tokenomics documentation and cookie policy"
        self.assertEqual(sanitize_text(value), value)


class RetryPolicyTests(unittest.TestCase):
    def test_default_retry_policy(self) -> None:
        policy = RetryPolicy()
        self.assertTrue(policy.can_retry(0))
        self.assertTrue(policy.can_retry(2))
        self.assertFalse(policy.can_retry(3))
        self.assertEqual(policy.delay_for(0), 5)
        self.assertEqual(policy.delay_for(1), 30)
        self.assertEqual(policy.delay_for(20), 120)

    def test_invalid_policy_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            RetryPolicy(max_attempts=0)
        with self.assertRaises(ValueError):
            RetryPolicy(backoff_seconds=())
        with self.assertRaises(ValueError):
            RetryPolicy(backoff_seconds=(1, -1))

    def test_negative_attempt_is_rejected(self) -> None:
        policy = RetryPolicy()
        with self.assertRaises(ValueError):
            policy.delay_for(-1)
        with self.assertRaises(ValueError):
            policy.can_retry(-1)


if __name__ == "__main__":
    unittest.main()
