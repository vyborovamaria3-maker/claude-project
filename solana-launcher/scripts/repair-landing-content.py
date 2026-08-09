from pathlib import Path
import base64, gzip, hashlib

root = Path(__file__).resolve().parent
parts = sorted((root / "landing-recovery").glob("part-*.b64"))
if not parts:
    raise SystemExit("landing recovery payload is missing")
payload = "".join(p.read_text(encoding="ascii").strip() for p in parts)
data = gzip.decompress(base64.b64decode(payload))
expected_size = 66823
expected_blob = "bbfa9116105d0b42afbbc04a2693542a21b7807f"
blob = hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()
if len(data) != expected_size or blob != expected_blob:
    raise SystemExit(f"landing recovery integrity check failed: size={len(data)} blob={blob}")
target = root.parent / "components" / "landing" / "landingContent.ts"
target.parent.mkdir(parents=True, exist_ok=True)
target.write_bytes(data)
data.decode("utf-8")
print(f"restored {target} ({len(data)} bytes, blob {blob})")
