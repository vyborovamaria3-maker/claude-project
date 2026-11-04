"""Isolated PostgreSQL lifecycle tests. Never defaults to a production database."""
import os,unittest,uuid,tempfile
from pathlib import Path
@unittest.skipUnless(os.environ.get('AUTHOR_OUTCOMES_TEST_DSN'),'AUTHOR_OUTCOMES_TEST_DSN not configured')
class PostgresTests(unittest.TestCase):
 def test_atomic_scan_price_proofs_retry_and_first_mentions(self):
  import psycopg
  from psycopg import sql
  from psycopg.rows import dict_row
  from worker import scan,link_confirmed,price_tick
  mint='5dBB7trtJaHKrRhnDzPrbmZny3QJNeEGVMaBSBa8pump'
  with psycopg.connect(os.environ['AUTHOR_OUTCOMES_TEST_DSN'],connect_timeout=8,row_factory=dict_row,autocommit=True) as db:
   with db.transaction(force_rollback=True):
    schema='test_author_'+uuid.uuid4().hex[:12];db.execute(sql.SQL('CREATE SCHEMA {}').format(sql.Identifier(schema)));db.execute(sql.SQL('SET LOCAL search_path TO {},pg_catalog').format(sql.Identifier(schema)))
    db.execute('CREATE TABLE twitter_tweets(tweet_id text PRIMARY KEY,handle text,text text,url text,posted_at bigint,first_seen_at bigint,updated_at bigint);CREATE TABLE tweet_entities(tweet_id text,entity_type text,value text);CREATE TABLE tweet_token_links(tweet_id text,mint text,handle text,linked_at bigint,PRIMARY KEY(tweet_id,mint))')
    db.execute((Path(__file__).parent/'schema.sql').read_text(encoding='utf-8-sig'))
    db.execute('INSERT INTO twitter_tweets VALUES(%s,%s,%s,NULL,300000,300001,1)',('100','Alice','buy '+mint))
    assert scan(db)==1;assert scan(db)==0;assert db.execute('SELECT count(*) n FROM xc_author_mint_candidates').fetchone()['n']==1
    assert db.execute('SELECT count(*) n FROM tweet_token_links').fetchone()['n']==0
    proof=dict(pool=mint,token_side='base',pool_observed_at=1,lookup_url='test',pool_record={},ohlcv_meta={})
    link_confirmed(db,mint,proof);assert db.execute('SELECT count(*) n FROM tweet_token_links').fetchone()['n']==1
    db.execute('UPDATE twitter_tweets SET text=%s,updated_at=2 WHERE tweet_id=%s',('no address','100'));scan(db)
    assert db.execute('SELECT count(*) n FROM tweet_token_links').fetchone()['n']==0
    assert not db.execute('SELECT active FROM xc_author_mint_candidates').fetchone()['active']
    db.execute('UPDATE twitter_tweets SET text=%s,updated_at=3 WHERE tweet_id=%s',('buy '+mint,'100'));scan(db);link_confirmed(db,mint,proof)
    db.execute('INSERT INTO twitter_tweets VALUES(%s,%s,%s,NULL,600000,600001,4)',('101','Alice','again '+mint));scan(db)
    from worker import FIRST
    assert len(db.execute(FIRST).fetchall())==1
    # Existing legacy links are never claimed/deleted by this evaluator.
    db.execute('INSERT INTO twitter_tweets VALUES(%s,%s,%s,NULL,900000,900001,5)',('102','Bob',mint))
    db.execute('INSERT INTO tweet_token_links VALUES(%s,%s,%s,1)',('102',mint,'bob'));scan(db);link_confirmed(db,mint,proof)
    db.execute('UPDATE twitter_tweets SET text=%s,updated_at=6 WHERE tweet_id=%s',('removed','102'));scan(db)
    assert db.execute('SELECT count(*) n FROM tweet_token_links WHERE tweet_id=\'102\'').fetchone()['n']==1
    import json,time
    class FakePrices:
     def history(self,mint,posted_at):
      times=sorted({t+h*3600000 for t in [300000,600000] for h in [0,1,24,72]})
      return dict(version=1,source='geckoterminal',network='solana',currency='usd',mint=mint,pool=mint,token_side='base',interval_ms=300000,fetched_at=int(time.time()*1000),pool_observed_at=1,lookup_url='test',pool_record={},ohlcv_meta={},candles=[[t,1,1,1,1,1] for t in times])
    with tempfile.TemporaryDirectory() as tmp:
     output=Path(tmp);(output/'group-price-queue.json').write_text(json.dumps({'tweet_ids':['101']}),encoding='utf8')
     price_tick(db,FakePrices(),output,limit=1)
     assert db.execute('SELECT count(*) n FROM xc_author_post_outcomes').fetchone()['n']==6
     assert db.execute('WITH firsts AS('+FIRST+') SELECT count(*) n FROM firsts f JOIN xc_author_post_outcomes o USING(tweet_id,mint,source_hash)').fetchone()['n']==3
    # Rate-limited tasks retry after 15m, respecting global backoff, never 12h.
    db.execute('DELETE FROM xc_author_post_outcomes');db.execute('DELETE FROM xc_author_price_evidence');db.execute('UPDATE xc_author_mint_candidates SET next_price_at=0 WHERE active')
    class RateLimited:
     def history(self,*args):raise ValueError('price_rate_limited')
    with tempfile.TemporaryDirectory() as tmp:
     start=int(time.time()*1000);price_tick(db,RateLimited(),Path(tmp),limit=1)
     backoff=db.execute('SELECT price_backoff_until FROM xc_author_eval_state').fetchone()['price_backoff_until']
     assert 899000<=backoff-start<=905000
     retry=db.execute("SELECT next_price_at FROM xc_author_mint_candidates WHERE last_price_status='price_rate_limited' LIMIT 1").fetchone()['next_price_at']
     assert 899000<=retry-start<=905000
    print('PASS: idempotent scan, address pending before validation, confirmation bridge, removal/reappearance, first-mention dedup, pre-existing links preserved; all DB changes rolled back')
