"""Checksum-pinned token snapshot subset of the June 2026 public MIT dataset.
No 9.5M-trade download. Dependency: scripts/archive/requirements.txt.
"""
import argparse
import hashlib
import json
import pathlib
import urllib.request
import pyarrow.parquet as pq
from importlib.util import spec_from_file_location, module_from_spec
spec = spec_from_file_location('solmemes', pathlib.Path(__file__).with_name('fetch-solmemes.py'))
helper = module_from_spec(spec)
spec.loader.exec_module(helper)
URL = 'https://raw.githubusercontent.com/ian05012/solana-memecoin-dataset/main/data/tokens.parquet'
BLOB = 'dcd5bb767194781916214bd05399eae162b5f322'

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', default='data/datasets/solana-memecoin')
    args = parser.parse_args()
    root = pathlib.Path(args.out)
    root.mkdir(parents=True, exist_ok=True)
    file = root/'tokens.parquet'
    if not file.exists():
        with urllib.request.urlopen(URL, timeout=60) as response:
            data = response.read(25*1024*1024+1)
        if len(data)>25*1024*1024:
            raise ValueError('download exceeds cap')
        if hashlib.sha1(('blob '+str(len(data))+'\0').encode()+data).hexdigest()!=BLOB:
            raise ValueError('upstream dataset changed: git blob checksum mismatch')
        file.write_bytes(data)
    data = file.read_bytes()
    if hashlib.sha1(('blob '+str(len(data))+'\0').encode()+data).hexdigest()!=BLOB:
        raise ValueError('dataset checksum mismatch')
    count = 0
    first = last = None
    temporary=root/'tokens.jsonl.tmp'
    with temporary.open('w', encoding='utf8') as output:
        for batch in pq.ParquetFile(file).iter_batches(batch_size=500):
            for row in batch.to_pylist():
                row=helper.clean(row)
                row['token']=row['token_address']
                output.write(json.dumps(row, ensure_ascii=False, allow_nan=False)+'\n')
                count+=1
                value=row.get('captured_at')
                if value:
                    first=value if first is None else min(first,value)
                    last=value if last is None else max(last,value)
    target=root/'tokens.jsonl'
    temporary.replace(target)
    manifest={'name':'Solana Memecoin Dataset — token snapshots','source':URL,'license':'MIT',
              'attribution':'ian05012/solana-memecoin-dataset, README and LICENSE; research dataset',
              'git_blob_sha1':BLOB,'sha256':hashlib.sha256(data).hexdigest(),
              'jsonl_sha256':hashlib.sha256(target.read_bytes()).hexdigest(),'rows':count,
              'captured_at_min':first,'captured_at_max':last,
              'kind':'token snapshot features and forward-return labels; not tweets',
              'bias':'detected tokens, June 2026 regime; forward-return labels must never enter feature inputs'}
    (root/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf8')
    print(json.dumps(manifest))

if __name__=='__main__':
    main()
