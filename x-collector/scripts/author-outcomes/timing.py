"""Publication timing against an explicitly bounded one-hour pre-window."""
import json,time,hashlib
from collections import defaultdict
from core import evaluate,HORIZONS,INTERVAL
THRESHOLD=.5

def assess(proof,posted_at,now):
 if proof['fetched_at']>now:return dict(label='insufficient_history',pre=None,observed_prior_24h=None,outcomes={str(h):{'reason':'evidence_from_future'} for h in HORIZONS},growth_horizons=[],entry_at=None,entry_usd=None,reason='evidence_from_future')
 entry=next((c for c in sorted(proof['candles']) if posted_at<=c[0]<=posted_at+INTERVAL and c[1]>0 and c[5]>0),None)
 floors=posted_at//INTERVAL*INTERVAL;wanted=list(range(floors-3600000,floors,INTERVAL));bytime={c[0]:c for c in proof['candles'] if c[0]+INTERVAL<=min(now,posted_at) and c[5]>0}
 pre=None
 if all(t in bytime for t in wanted):
  rows=[bytime[t] for t in wanted];baseline=rows[0][1]
  pre=dict(first_at=rows[0][0],last_close_at=rows[-1][0]+INTERVAL,open_usd=baseline,close_usd=rows[-1][4],return_1h=rows[-1][4]/baseline-1,peak_gain_1h=max(c[2] for c in rows)/baseline-1,peak_at=max(rows,key=lambda c:c[2])[0],candles=rows,price_quality='thin_candle' if min(c[5] for c in rows)<100 else 'observed_price',peak_volume_usd=max(rows,key=lambda c:c[2])[5],baseline_volume_usd=rows[0][5])
 # A witnessed prior rise needs two ordered traded opens, not complete coverage.
 prior=[c for c in sorted(proof['candles']) if floors-86400000<=c[0] and c[0]+INTERVAL<=min(now,posted_at) and c[5]>0]
 observed=None
 if len(prior)>=2:
  low=prior[0];best=(0,low,low)
  for candle in prior[1:]:
   gain=candle[1]/low[1]-1
   if gain>best[0]:best=(gain,low,candle)
   if candle[1]<low[1]:low=candle
  peak=max(prior,key=lambda c:c[1]);gain,start,end=best
  observed=dict(first_at=prior[0][0],last_at=prior[-1][0],candles=len(prior),observed_max_rise=gain,rise_from_at=start[0],rise_from_usd=start[1],rise_to_at=end[0],rise_to_usd=end[1],observed_peak_at=peak[0],observed_peak_usd=peak[1],post_vs_observed_peak=entry[1]/peak[1]-1 if entry else None,rise_from_volume_usd=start[5],rise_to_volume_usd=end[5],price_quality='thin_candle' if min(start[5],end[5])<100 else 'observed_price',complete_24h=len(prior)==288 and all(prior[i+1][0]-prior[i][0]==INTERVAL for i in range(len(prior)-1)))
 outcomes={}
 for h in HORIZONS:
  result,reason=evaluate(proof,posted_at,h,now);outcomes[str(h)]=result if result else {'reason':reason}
 growth=[h for h in HORIZONS if outcomes[str(h)].get('gross_return',-1)>=THRESHOLD and outcomes[str(h)].get('price_quality')!='thin_candle']
 if (observed and observed['observed_max_rise']>=THRESHOLD and observed['price_quality']=='observed_price') or (pre and pre['peak_gain_1h']>=THRESHOLD and min(pre['baseline_volume_usd'],pre['peak_volume_usd'])>=100):label='after_prior_jump'
 elif pre and pre['price_quality']=='observed_price' and growth:label='before_later_growth'
 elif not pre and growth:label='later_growth_prior_unknown'
 elif pre and pre['price_quality']=='observed_price' and any(o.get('gross_return') is not None and o.get('price_quality')!='thin_candle' for o in outcomes.values()):label='no_50pct_event'
 else:label='insufficient_history'
 return dict(label=label,pre=pre,observed_prior_24h=observed,outcomes=outcomes,growth_horizons=growth,entry_at=entry[0] if entry else None,entry_usd=entry[1] if entry else None,reason=None if pre else 'pre_hour_incomplete_or_untraded')

def timing_report(db,groups,stamp):
 rows={}
 for g in groups:
  for m in g['members']:rows.setdefault((m['tweet_id'],g['mint']),{**m,'group_ids':set()})['group_ids'].add(g['id'])
 group_post_count=len(rows)
 requested={(m['author'],mint) for (_,mint),m in rows.items()}
 scope_ids={}
 for (_,mint),m in rows.items():scope_ids.setdefault((m['author'],mint),set()).update(m['group_ids']);m['scope']='group_post'
 mints=sorted({mint for _,mint in rows})
 first_mentions=db.execute('SELECT DISTINCT ON(author,mint) tweet_id,mint,author,posted_at,source_text,source_hash,url FROM xc_author_mint_candidates WHERE active AND mint=ANY(%s::text[]) ORDER BY author,mint,posted_at,tweet_id',(mints,)).fetchall()
 for m in first_mentions:
  if (m['author'],m['mint']) not in requested:continue
  key=m['tweet_id'],m['mint']
  if key not in rows:rows[key]={**m,'group_ids':set(scope_ids[m['author'],m['mint']]),'scope':'earlier_context'}
  rows[key]['first_stored_mention']=True
 histories=defaultdict(list)
 for h in db.execute('SELECT mint,evidence_hash,proof FROM xc_author_price_evidence WHERE mint=ANY(%s::text[]) ORDER BY fetched_at DESC',(mints,)).fetchall():histories[h['mint']].append(h)
 records=[]
 for (postid,mint),m in rows.items():
  choices=[]
  for h in histories[mint]:
   if h['proof'].get('mint')!=mint:continue
   a=assess(h['proof'],m['posted_at'],stamp)
   # Select by data coverage, never by sign or size of the return.
   score=(a['pre'] is not None,sum(o.get('gross_return') is not None for o in a['outcomes'].values()),h['proof']['fetched_at'])
   choices.append((score,a,h['evidence_hash']))
  if choices:_,result,sha=max(choices,key=lambda x:x[0])
  else:result=dict(label='insufficient_history',pre=None,observed_prior_24h=None,outcomes={str(h):{'reason':'price_history_missing'} for h in HORIZONS},growth_horizons=[],entry_at=None,entry_usd=None,reason='price_history_missing');sha=None
  records.append(dict(tweet_id=postid,mint=mint,author=m['author'],posted_at=m['posted_at'],source_text=m['source_text'],source_hash=m['source_hash'],scope=m['scope'],first_stored_mention=m.get('first_stored_mention',False),group_ids=sorted(m['group_ids']),evidence_hash=sha,**result))
 first={}
 for r in sorted(records,key=lambda r:(r['posted_at'],r['tweet_id'])):first.setdefault((r['author'],r['mint']),r)
 authors=[]
 for author in sorted({r['author'] for r in records}):
  samples=[r for (a,_),r in first.items() if a==author];labels=defaultdict(int)
  for r in samples:labels[r['label']]+=1
  authors.append(dict(author=author,distinct_ca=len(samples),with_pre_history=sum(r['pre'] is not None for r in samples),before_later_growth=labels['before_later_growth'],after_prior_jump=labels['after_prior_jump'],growth_prior_unknown=labels['later_growth_prior_unknown'],no_event=labels['no_50pct_event'],unknown=labels['insufficient_history']))
 authors.sort(key=lambda a:(-a['with_pre_history'],-a['distinct_ca'],a['author']))
 labels=defaultdict(int)
 for r in records:labels[r['label']]+=1
 records.sort(key=lambda r:(r['label']=='insufficient_history',r['label']=='no_50pct_event',-r['posted_at'],r['tweet_id']))
 return dict(version=1,checked_at=stamp,coverage={'groups':len(groups),'group_posts_ca':group_post_count,'earlier_context_posts':len(records)-group_post_count,'posts_ca':len(records),'with_pre_hour':sum(r['pre'] is not None for r in records),'with_any_forward_return':sum(any(o.get('gross_return') is not None for o in r['outcomes'].values()) for r in records),'thin_post_horizons':sum(o.get('price_quality')=='thin_candle' for r in records for o in r['outcomes'].values()),'labels':dict(labels)},authors=authors,records=records,method={'prior_window':'12 consecutive traded 5m candles before floor(post time); observed 24h also ends at that boundary, up to 5m before publication. Excludes every overlapping candle. No gap or zero-volume forward filling. Not a token all-time high.','after_prior_jump':'Prior completed-hour high/open gain >=50% OR witnessed >=50% rise between ordered traded candle OPENS during the preceding 24h. Incomplete 24h coverage permits witnessing a rise, not proving absence of one. Can coexist with later growth; not an all-time peak or author PNL.','before_later_growth':'Complete prior-hour peak <50%, no witnessed 24h rise >=50%, followed by >=50% gross fixed-horizon return at 1/24/72h. Missing older history prevents a global early-call conclusion; this label describes the stated window only.','missing_prior':'Forward growth with missing prior-hour data is separately labelled, never called early.','entry_exit':'First traded 5m open at/after post or entry+horizon, maximum delay 5m. USD, finished candles only. Net includes 1% each side.','selection':'Single price response chosen by prior-hour and forward-horizon coverage, not outcome sign. Current-pool survivorship bias and price coverage remain unknown.','author_counts':'One earliest stored mention per participating author/CA, explicitly looking before the detected group window. Earlier-context posts are marked and are not claimed as group members; repeats never inflate author totals. Retrospective descriptive study; no statistical significance test.','thin_price_rule':'Entry or exit 5m candle USD volume <100 is explicitly flagged, not accepted as evidence of a future growth signal. This heuristic is not a guarantee of execution for higher-volume candles. Thin negative returns remain visible only as low-quality price observations.', 'limits':'Original images and missing/deleted posts not reconstructed. Labels refer only to declared windows and thresholds, not global pump timing or actual buy recommendations.'})
