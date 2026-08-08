from __future__ import annotations

import base64
import secrets
import urllib.parse


def main() -> None:
    secret = base64.b32encode(secrets.token_bytes(20)).decode("ascii").rstrip("=")
    issuer = "POTAPoff"
    account = "admin@potapoff.fun"
    label = urllib.parse.quote(f"{issuer}:{account}")
    query = urllib.parse.urlencode({"secret": secret, "issuer": issuer, "algorithm": "SHA1", "digits": 6, "period": 30})
    print(secret)
    print(f"otpauth://totp/{label}?{query}")
    print("Store the secret only in ADMIN_TOTP_SECRET. Do not commit it.")


if __name__ == "__main__":
    main()
