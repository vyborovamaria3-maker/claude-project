"""Persistent, bounded scanner and evaluator; run under the existing supervisor."""
import argparse,json,os,sys,time,signal
from pathlib import Path
import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from core import addresses,digest,text_hash,PriceSource,evaluate,HORIZONS
HERE=Path(__file__).resolve().parent
FIRST="""SELECT DISTINCT ON(author,mint) * FROM xc_author_mint_candidates WHERE active ORDER BY author,mint,posted_at,tweet_id"""
stop=False
def stopping(*_):
 global stop;stop=True
for s in (signal.SIGTERM,signal.SIGINT):signal.signal(s,stopping)
def now():return int(time.time()*1000)
def atomic(path,data):
 path.parent.mkdir(parents=True,exist_ok=True);temp=path.with_suffix('.tmp');temp.write_text(json.dumps(data,ensure_ascii=False,default=str,allow_nan=False),encoding='utf8');os.replace(temp,path)
def scan(db,batch=10000):
 with db.transaction():
  state=db.execute('SELECT * FROM xc_author_eval_state WHERE id FOR UPDATE').fetchone()
  rows=db.execute('SELECT tweet_id,handle,text,url,posted_at,first_seen_at,updated_at FROM twitter_tweets WHERE (updated_at,tweet_id)>(%s,%s) ORDER BY updated_at,tweet_id LIMIT %s',(state['cursor_at'],state['cursor_id'],batch)).fetchall()
  if not rows:
   db.execute('UPDATE xc_author_eval_state SET scan_caught_up=true,last_scan_at=%s WHERE id',(now(),));return 0
  ids=[x['tweet_id'] for x in rows]
  urls={}
  # Expanded URLs already extracted by the collector, never resolve arbitrary URLs.
  for x in db.execute("SELECT tweet_id,value FROM tweet_entities WHERE tweet_id=ANY(%s::text[]) AND upper(entity_type)='URL'",(ids,)).fetchall():urls.setdefault(x['tweet_id'],[]).append(x['value'])
  previous={}
  for item in db.execute('SELECT tweet_id,mint,legacy_link_owned FROM xc_author_mint_candidates WHERE tweet_id=ANY(%s::text[]) AND active',(ids,)).fetchall():previous.setdefault(item['tweet_id'],[]).append(item)
  for row in rows:
   old=previous.get(row['tweet_id'],[])
   mints=set(addresses(row['text']+' '+(row['url'] or '')+' '+' '.join(urls.get(row['tweet_id'],[]))))
   if not mints and not old:continue
   sha=text_hash(row['text']);stamp=now()
   for item in old:
    if item['mint'] not in mints:
     if item['legacy_link_owned']:db.execute('DELETE FROM tweet_token_links WHERE tweet_id=%s AND mint=%s',(row['tweet_id'],item['mint']))
     db.execute('UPDATE xc_author_mint_candidates SET active=false,legacy_link_owned=false WHERE tweet_id=%s AND mint=%s',(row['tweet_id'],item['mint']))
   if not row['posted_at'] or row['posted_at']>stamp+60000:continue
   for mint in mints:
    db.execute("""INSERT INTO xc_author_mint_candidates(tweet_id,mint,author,posted_at,source_text,source_hash,first_seen_at,discovered_at,url)
    VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(tweet_id,mint) DO UPDATE SET author=excluded.author,posted_at=excluded.posted_at,source_text=excluded.source_text,source_hash=excluded.source_hash,url=excluded.url,active=true,
    next_price_at=CASE WHEN xc_author_mint_candidates.source_hash<>excluded.source_hash THEN 0 ELSE xc_author_mint_candidates.next_price_at END""",(row['tweet_id'],mint,row['handle'].lower(),row['posted_at'],row['text'],sha,row['first_seen_at'],stamp,row['url']))
  bridge_known(db,ids)
  last=rows[-1];db.execute('UPDATE xc_author_eval_state SET cursor_at=%s,cursor_id=%s,scanned=scanned+%s,last_scan_at=%s,scan_caught_up=false WHERE id',(last['updated_at'],last['tweet_id'],len(rows),now()))
  return len(rows)
def bridge_known(db,ids):
 inserted=db.execute("""INSERT INTO tweet_token_links(tweet_id,mint,handle,linked_at) SELECT c.tweet_id,c.mint,c.author,%s FROM xc_author_mint_candidates c JOIN xc_author_mint_registry r USING(mint) WHERE c.active AND r.status='confirmed' AND c.tweet_id=ANY(%s::text[]) ON CONFLICT DO NOTHING RETURNING tweet_id,mint""",(now(),ids)).fetchall()
 for x in inserted:db.execute('UPDATE xc_author_mint_candidates SET legacy_link_owned=true WHERE tweet_id=%s AND mint=%s',(x['tweet_id'],x['mint']))

def link_confirmed(db,mint,proof):
 with db.transaction():
  db.execute("INSERT INTO xc_author_mint_registry VALUES(%s,'confirmed',%s,%s,%s,NULL) ON CONFLICT(mint) DO UPDATE SET status='confirmed',checked_at=excluded.checked_at,retry_at=excluded.retry_at,proof=excluded.proof,last_error=NULL",(mint,now(),now()+86400000,Jsonb({k:proof[k] for k in ('pool','token_side','pool_observed_at','lookup_url','pool_record','ohlcv_meta')})))
  inserted=db.execute("""INSERT INTO tweet_token_links(tweet_id,mint,handle,linked_at) SELECT tweet_id,mint,author,%s FROM xc_author_mint_candidates WHERE mint=%s AND active ON CONFLICT DO NOTHING RETURNING tweet_id""",(now(),mint)).fetchall()
  if inserted:db.execute('UPDATE xc_author_mint_candidates SET legacy_link_owned=true WHERE mint=%s AND tweet_id=ANY(%s::text[])',(mint,[x['tweet_id'] for x in inserted]))
def price_tick(db,source,output,limit=4):
 if db.execute('SELECT price_backoff_until FROM xc_author_eval_state WHERE id').fetchone()['price_backoff_until']>now():return 0
 group_ids=[];priority_ids=[]
 try:
  group_report=json.loads((output/'group-price-queue.json').read_text(encoding='utf8'))
  group_ids=group_report.get('tweet_ids',[]);priority_ids=group_report.get('priority_tweet_ids',[])
 except (OSError,ValueError,KeyError):pass
 rows=db.execute('WITH firsts AS('+FIRST+"), selected AS(SELECT * FROM firsts UNION SELECT * FROM xc_author_mint_candidates WHERE active AND tweet_id=ANY(%s::text[])) SELECT f.* FROM selected f LEFT JOIN xc_author_mint_registry r USING(mint) WHERE f.next_price_at<=%s AND (r.retry_at IS NULL OR r.status='confirmed' OR r.retry_at<=%s) ORDER BY CASE WHEN f.tweet_id=ANY(%s::text[]) THEN 0 WHEN f.tweet_id=ANY(%s::text[]) THEN 1 ELSE 2 END,f.posted_at DESC LIMIT %s",(group_ids,now(),now(),priority_ids,group_ids,limit*6)).fetchall()
 visited=set();requests=0
 for row in rows:
  if stop or requests>=limit:break
  mint=row['mint'];key=(mint,row['posted_at']//86400000)
  if key in visited:continue
  visited.add(key)
  cached=db.execute('SELECT proof FROM xc_author_price_evidence WHERE mint=%s AND first_at<=%s AND last_at>=%s ORDER BY fetched_at DESC LIMIT 1',(mint,row['posted_at']+300000,min(now()-300000,row['posted_at']+72*3600000))).fetchone()
  try:
   if cached:proof=cached['proof']
   else:requests+=1;proof=source.history(mint,row['posted_at'])
   sha=digest(proof);atomic(output/'evidence'/('author-'+sha+'.json'),proof)
   candles=proof['candles'];first=candles[0][0] if candles else None;last=candles[-1][0] if candles else None
   with db.transaction():db.execute('INSERT INTO xc_author_price_evidence VALUES(%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING',(sha,mint,proof['pool'],proof['fetched_at'],first,last,Jsonb(proof)))
   link_confirmed(db,mint,proof)
   # Reuse one immutable response for all first mentions covered by this window.
   signals=db.execute('WITH firsts AS('+FIRST+'), selected AS(SELECT * FROM firsts UNION SELECT * FROM xc_author_mint_candidates WHERE active AND tweet_id=ANY(%s::text[])) SELECT * FROM selected WHERE mint=%s AND posted_at BETWEEN %s AND %s',(group_ids,mint,(first or row['posted_at'])-300000,last or row['posted_at'])).fetchall()
   if not any(s['tweet_id']==row['tweet_id'] for s in signals):signals.append(row)
   with db.transaction():
    for s in signals:
     reasons=[]
     for horizon in HORIZONS:
      result,reason=evaluate(proof,s['posted_at'],horizon,now())
      if not result:reasons.append(reason);continue
      mode='prospective' if abs(s['first_seen_at']-s['posted_at'])<=300000 and abs(s['discovered_at']-s['posted_at'])<=300000 else 'retrospective'
      db.execute("""INSERT INTO xc_author_post_outcomes VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
      ON CONFLICT(tweet_id,mint,horizon_hours) DO UPDATE SET source_hash=excluded.source_hash,entry_at=excluded.entry_at,exit_at=excluded.exit_at,entry_usd=excluded.entry_usd,exit_usd=excluded.exit_usd,gross_return=excluded.gross_return,net_return=excluded.net_return,evidence_hash=excluded.evidence_hash,evaluated_at=excluded.evaluated_at,mode=excluded.mode""",(s['tweet_id'],mint,horizon,s['source_hash'],result['entry_at'],result['exit_at'],result['entry_usd'],result['exit_usd'],result['gross_return'],result['net_return'],sha,now(),mode))
     status='complete' if not reasons else ','.join(sorted(set(reasons)))
     delay=900000 if 'immature' in reasons else 12*3600000 if reasons else 365*86400000
     db.execute('UPDATE xc_author_mint_candidates SET next_price_at=%s,last_price_status=%s WHERE tweet_id=%s AND mint=%s',(now()+delay,status,s['tweet_id'],mint))
    db.execute('UPDATE xc_author_eval_state SET last_price_at=%s,last_error=NULL WHERE id',(now(),))
  except (ValueError,OSError) as e:
   code=str(e) if str(e) in ('price_rate_limited','price_http_error','price_source_unavailable','token_pool_not_confirmed','token_identity_mismatch','invalid_candles','invalid_candle') else 'price_source_unavailable'
   retry_delay=900000 if code=='price_rate_limited' else 12*3600000
   with db.transaction():
    db.execute('UPDATE xc_author_mint_candidates SET next_price_at=%s,last_price_status=%s WHERE tweet_id=%s AND mint=%s',(now()+retry_delay,code,row['tweet_id'],mint))
    db.execute("INSERT INTO xc_author_mint_registry VALUES(%s,'unconfirmed',%s,%s,NULL,%s) ON CONFLICT(mint) DO UPDATE SET retry_at=excluded.retry_at,last_error=excluded.last_error",(mint,now(),now()+retry_delay,code))
    db.execute('UPDATE xc_author_eval_state SET last_error=%s WHERE id',(code,))
   if code=='price_rate_limited':
    db.execute('UPDATE xc_author_eval_state SET price_backoff_until=%s WHERE id',(now()+900000,));break
 return requests

def publish(db,output):
 with db.transaction():
  db.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
  state=db.execute('SELECT * FROM xc_author_eval_state').fetchone()
  totals=db.execute("""SELECT count(*) candidates,count(DISTINCT c.mint) candidate_tokens,count(DISTINCT author) authors,count(*) FILTER(WHERE r.status='confirmed') confirmed_posts,count(DISTINCT c.mint) FILTER(WHERE r.status='confirmed') confirmed_tokens FROM xc_author_mint_candidates c LEFT JOIN xc_author_mint_registry r USING(mint) WHERE active""").fetchone()
  reasons=db.execute('SELECT last_price_status,count(*) posts FROM xc_author_mint_candidates WHERE active GROUP BY 1 ORDER BY count(*) DESC').fetchall()
  eligible='WITH firsts AS('+FIRST+'), evaluated AS(SELECT c.author,c.posted_at,o.* FROM firsts c JOIN xc_author_post_outcomes o USING(tweet_id,mint,source_hash)) '
  authors=db.execute(eligible+"""SELECT author,horizon_hours,count(*) tokens,count(DISTINCT posted_at/86400000) days,count(*) FILTER(WHERE mode='prospective') prospective,count(*) FILTER(WHERE net_return>0) wins,avg(net_return) mean_net,percentile_cont(.5) WITHIN GROUP(ORDER BY net_return) median_net,min(net_return) worst_net,max(net_return) best_net FROM evaluated GROUP BY author,horizon_hours ORDER BY count(*)>=20 DESC,count(*) DESC,author LIMIT 100""").fetchall()
  examples=db.execute('WITH firsts AS('+FIRST+""") SELECT c.author,c.source_text,c.url,c.posted_at,c.first_seen_at,c.discovered_at,o.* FROM firsts c JOIN xc_author_post_outcomes o USING(tweet_id,mint,source_hash) ORDER BY o.evaluated_at DESC,c.posted_at DESC LIMIT 60""").fetchall()
  candidates=db.execute("SELECT c.tweet_id,c.mint,c.author,c.posted_at,left(c.source_text,1200) source_text,c.url,c.last_price_status,r.status token_status FROM xc_author_mint_candidates c LEFT JOIN xc_author_mint_registry r USING(mint) WHERE c.active ORDER BY c.posted_at DESC LIMIT 30").fetchall()
  counts=db.execute(eligible+'SELECT horizon_hours,count(*) outcomes,count(DISTINCT author) authors,count(*) FILTER(WHERE mode=\'prospective\') prospective FROM evaluated GROUP BY horizon_hours').fetchall()
 report=dict(version=1,checked_at=now(),state=state,totals=totals,reasons=reasons,authors=authors,outcomes=counts,examples=examples,candidates=candidates,method={'chain':'solana','identity':'literal 32-byte base58 in stored text or extracted URL; token membership confirmed by GeckoTerminal pool metadata','firstMention':'earliest active stored post per author and mint; incomplete archives can move the first mention','horizons':HORIZONS,'entry':'first traded 5m candle open at or after post, lag<=5m','exit':'first traded 5m candle open at or after entry+horizon, lag<=5m','net':'exit*0.99/(entry*1.01)-1; hypothetical 1% cost each side','minimumSample':'20 distinct tokens and 10 UTC publication days; descriptive only, no validated profitable authors','mode':'retrospective unless post collected and linked within 5 minutes of publication','limitations':'USD market-price markouts, not actual author PNL. No ownership or buy-intent inference; historical liquidity/execution not verified. Current pool selection causes survivorship bias. Missing old prices never filled with current prices. No forward-filled empty candles. Not an out-of-sample backtest.'})
 atomic(output/'report.json',report)
 from groups import refresh_groups
 refresh_groups(db,output,atomic)
 print(json.dumps({'scanned':state['scanned'],'caughtUp':state['scan_caught_up'],**totals,'outcomes':counts}),flush=True)

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--once',action='store_true');parser.add_argument('--backfill',action='store_true');parser.add_argument('--migrate',action='store_true');args=parser.parse_args()
 output=Path(os.environ['AUTHOR_OUTCOMES_DIRECTORY']);dsn=os.environ['AUTHOR_OUTCOMES_DSN'];source=PriceSource()
 with psycopg.connect(dsn,connect_timeout=10,row_factory=dict_row,autocommit=True) as db:
  db.execute("SET statement_timeout='90s'")
  if not db.execute('SELECT pg_try_advisory_lock(742098553) locked').fetchone()['locked']:return
  if args.migrate:
   with db.transaction():db.execute((HERE/'schema.sql').read_text(encoding='utf-8-sig'))
  while not stop:
   for _ in range(10 if not args.backfill else 200):
    if stop or not scan(db):break
   publish(db,output)
   if not args.backfill:price_tick(db,source,output);publish(db,output)
   if args.once or args.backfill:return
   for _ in range(60):
    if stop:return
    time.sleep(1)
if __name__=='__main__':
 try:main()
 except Exception:
  print('Author evaluation unavailable; reconnect through supervisor, previous results retained.',file=sys.stderr);sys.exit(1)
