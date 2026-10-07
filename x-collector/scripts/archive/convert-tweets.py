"""Stream a CSV/JSONL/Parquet dataset into canonical tweet JSONL.
Mapping JSON maps canonical names to source column names. IDs remain strings.
Requires pyarrow only for Parquet. Never invents missing tweet IDs or dates.
"""
import argparse
import csv
import datetime as dt
import json
import pathlib

ALIASES = {
    'id': ['id', 'tweet_id', 'Tweet_ID'], 'text': ['text', 'tweet', 'full_text'],
    'created_at': ['created_at', 'timestamp', 'date', 'Date'],
    'author_id': ['author_id', 'user_id'], 'username': ['username', 'user_name'],
    'conversation_id': ['conversation_id'],
    'metrics_observed_at': ['metrics_observed_at', 'captured_at', 'scraped_at', 'collected_at'],
    'like_count': ['like_count', 'likes'], 'impression_count': ['impression_count', 'views'],
    'retweet_count': ['retweet_count', 'retweets'], 'reply_count': ['reply_count', 'replies'],
    'quote_count': ['quote_count', 'quotes']
}

def rows(file):
    if file.suffix == '.parquet':
        import pyarrow.parquet as pq
        for batch in pq.ParquetFile(file).iter_batches(batch_size=500):
            yield from batch.to_pylist()
    elif file.suffix == '.csv':
        with file.open(encoding='utf-8-sig', newline='') as source:
            yield from csv.DictReader(source)
    else:
        with file.open(encoding='utf8') as source:
            for line in source:
                if line.strip():
                    yield json.loads(line)

def timestamp(value):
    if isinstance(value, dt.datetime):
        date = value
    elif isinstance(value, str):
        try:
            date = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
        except ValueError:
            date = dt.datetime.strptime(value, '%a %b %d %H:%M:%S %z %Y')
    else:
        raise ValueError('explicit date string required')
    if date.tzinfo is None:
        date = date.replace(tzinfo=dt.timezone.utc)
    return date.isoformat()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--mapping')
    parser.add_argument('--start')
    parser.add_argument('--end')
    args = parser.parse_args()
    mapping = json.loads(pathlib.Path(args.mapping).read_text()) if args.mapping else {}
    count = skipped = 0
    temporary = pathlib.Path(args.out+'.tmp')
    start = dt.datetime.fromisoformat(timestamp(args.start)) if args.start else None
    end = dt.datetime.fromisoformat(timestamp(args.end)) if args.end else None
    try:
        with temporary.open('w', encoding='utf8') as output:
            for number, row in enumerate(rows(pathlib.Path(args.input)), 1):
                def pick(field):
                    for key in [mapping[field]] if field in mapping else ALIASES.get(field, [field]):
                        if row.get(key) is not None and row[key] != '':
                            return row[key]
                    return None
                tweet_id, text, date = pick('id'), pick('text'), pick('created_at')
                if tweet_id is None or isinstance(tweet_id, float) or not str(tweet_id).isdigit() or text is None:
                    raise ValueError('missing/unsafe tweet ID or text at row '+str(number))
                date = timestamp(date)
                moment = dt.datetime.fromisoformat(date)
                if (start and moment < start) or (end and moment >= end):
                    skipped += 1
                    continue
                result = {'id': str(tweet_id), 'text': str(text), 'created_at': date,
                          '_dataset_original': {k: str(v) if isinstance(v, (dt.datetime, dt.date)) or (isinstance(v, int) and abs(v)>2**53-1) else v for k,v in row.items()}}
                for key in ['author_id', 'conversation_id']:
                    value = pick(key)
                    if value is not None:
                        if isinstance(value, float) or not str(value).isdigit():
                            raise ValueError('unsafe '+key+' at row '+str(number))
                        result[key] = str(value)
                if pick('metrics_observed_at') is not None:
                    result['metrics_observed_at'] = timestamp(pick('metrics_observed_at'))
                metrics = {}
                for key in ['like_count', 'impression_count', 'retweet_count', 'reply_count', 'quote_count']:
                    value = pick(key)
                    if value is not None:
                        metric = int(str(value).replace(',', ''))
                        if metric < 0 or metric > 2**53-1:
                            raise ValueError('invalid metric at row '+str(number))
                        metrics[key] = metric
                if metrics:
                    result['public_metrics'] = metrics
                if result.get('author_id') and pick('username'):
                    result['user_profile'] = {'id': result['author_id'], 'username': str(pick('username'))}
                output.write(json.dumps(result, ensure_ascii=False, allow_nan=False)+'\n')
                count += 1
        temporary.replace(args.out)
    finally:
        temporary.unlink(missing_ok=True)
    print(json.dumps({'rows': count, 'outside_range': skipped}))

if __name__ == '__main__':
    main()
