"""Download a checksum-pinned public dataset; stream Parquet into JSONL.
Optional dependency: pip install -r scripts/archive/requirements.txt
No credentials or X requests. Never runs migration or touches a database.
"""
import argparse
import datetime as dt
import hashlib
import json
import math
import pathlib
import urllib.request
import pyarrow.parquet as pq

SHA256 = '1ac22b5cf496ca1aba7132a3b87b4384c98e5fc300b08fa4ef238227a918d0ef'
URL = 'https://huggingface.co/datasets/rucyfer/solmemes/resolve/main/pump_swap_final_with_metadata.parquet'

def clean(value):
    if isinstance(value, (dt.datetime, dt.date)):
        if isinstance(value, dt.datetime) and value.tzinfo is None:
            value = value.replace(tzinfo=dt.timezone.utc)
        return value.isoformat()
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {key: clean(item) for key, item in value.items()}
    if isinstance(value, list):
        return [clean(item) for item in value]
    return value

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', default='data/datasets/solmemes')
    args = parser.parse_args()
    root = pathlib.Path(args.out)
    root.mkdir(parents=True, exist_ok=True)
    file = root / 'solmemes.parquet'
    if not file.exists():
        temporary = root / 'download.tmp'
        try:
            with urllib.request.urlopen(URL, timeout=60) as response, temporary.open('wb') as output:
                size = 0
                while chunk := response.read(1024 * 1024):
                    size += len(chunk)
                    if size > 10 * 1024 * 1024:
                        raise ValueError('dataset exceeds 10MB download cap')
                    output.write(chunk)
            if hashlib.sha256(temporary.read_bytes()).hexdigest() != SHA256:
                raise ValueError('upstream dataset changed: checksum mismatch')
            temporary.replace(file)
        finally:
            temporary.unlink(missing_ok=True)
    digest = hashlib.sha256(file.read_bytes()).hexdigest()
    if digest != SHA256:
        raise ValueError('dataset checksum mismatch')
    count, first, last = 0, None, None
    temporary = root / 'solmemes.jsonl.tmp'
    with temporary.open('w', encoding='utf8') as output:
        for batch in pq.ParquetFile(file).iter_batches(batch_size=500):
            for row in batch.to_pylist():
                row = clean(row)
                output.write(json.dumps(row, ensure_ascii=False, allow_nan=False) + '\n')
                count += 1
                date = row.get('created_at')
                if date:
                    first = date if first is None else min(first, date)
                    last = date if last is None else max(last, date)
    target = root / 'solmemes.jsonl'
    temporary.replace(target)
    manifest = {'name': 'SOLMEMES', 'source': URL, 'license': 'Apache-2.0',
                'attribution': 'Bruno Rucy Carneiro Alves de Lima; Victor Henrique Cabral Pinheiro. SOLMEMES (AICCC 2025), doi:10.1145/3789982.3790023',
                'sha256': digest, 'jsonl_sha256': hashlib.sha256(target.read_bytes()).hexdigest(),
                'rows': count, 'created_at_min': first, 'created_at_max': last,
                'kind': 'token metadata and 15 minute price/trade samples; not tweets',
                'bias': 'graduated tokens only; not an unbiased population sample'}
    (root / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2)+'\n', encoding='utf8')
    print(json.dumps(manifest, ensure_ascii=False))

if __name__ == '__main__':
    main()
