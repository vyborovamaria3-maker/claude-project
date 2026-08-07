#!/usr/bin/env python3
from getpass import getpass

from app.auth import hash_password

password = getpass("Admin password: ")
confirmation = getpass("Repeat password: ")
if password != confirmation:
    raise SystemExit("Passwords do not match")
if len(password) < 12:
    raise SystemExit("Use at least 12 characters")
print(hash_password(password))
