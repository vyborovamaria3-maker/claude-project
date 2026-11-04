"""Time-bounded shared-address text clusters. Descriptive links, no ownership claims."""
import collections,hashlib,json,re,time,unicodedata
from pathlib import Path
from core import ADDRESS,evaluate,HORIZONS
WINDOW=15*60000
STOP=set('the and for this that with from your you our are was will have has token coin meme memecoin solana crypto pump launch airdrop live alert check explore discover ca sol ray buy now here new more just its get usd market onchain signal'.split())
def features(text):
 text=ADDRESS.sub(' ',unicodedata.normalize('NFKC',text));text=text.lower();text=re.sub(r'https?://\S+',' ',text);text=re.sub(r'\$[a-z0-9_]+',' ',text)
 words=set(re.findall(r'[a-z]{4,}',text))-STOP
 norm=' '.join(re.findall(r'[^\W_]+',text));grams={norm[i:i+4] for i in range(max(0,len(norm)-3))}
 return words,grams,norm

def pair(a,b,df):
 wa,ga,na=a;wb,gb,nb=b;shared=wa&wb
 j=len(shared)/len(wa|wb) if wa|wb else 0
 dice=2*len(ga&gb)/(len(ga)+len(gb)) if ga or gb else 0
 anchors=sorted(x for x in shared if len(x)>=5 and df[x]<=100)
 rare=len(anchors)>=2 and any(len(x)>=8 for x in anchors)
 if (len(shared)>=5 and j>=.35) or (min(len(na),len(nb))>=60 and dice>=.45) or rare:
  return dict(word_jaccard=round(j,4),character_dice=round(dice,4),anchors=anchors[:12],method='shared_rare_words' if rare and j<.35 and dice<.45 else 'text_overlap')

def detect(rows):
 fs={r['tweet_id']:features(r['source_text']) for r in rows};df=collections.Counter()
 # Count each source post once even if it mentions several addresses.
 for f in fs.values():df.update(f[0])
 by_mint=collections.defaultdict(list)
 for r in rows:by_mint[r['mint']].append(r)
 groups=[];comparisons=0
 for mint,posts in by_mint.items():
  posts.sort(key=lambda r:(r['posted_at'],r['tweet_id']));edges={};adj=collections.defaultdict(set)
  for i,a in enumerate(posts):
   for j in range(i+1,len(posts)):
    b=posts[j]
    if b['posted_at']-a['posted_at']>WINDOW:break
    if a['author']==b['author']:continue
    comparisons+=1;proof=pair(fs[a['tweet_id']],fs[b['tweet_id']],df)
    if proof:
     edges[i,j]=dict(a=a['tweet_id'],b=b['tweet_id'],gap_seconds=(b['posted_at']-a['posted_at'])/1000,**proof);adj[i].add(j);adj[j].add(i)
  sets=[]
  for i in range(len(posts)):
   if not adj[i]:continue
   seen={i};pending=[i]
   while pending:
    u=pending.pop()
    for v in adj[u]:
     if v not in seen and posts[i]['posted_at']<=posts[v]['posted_at']<=posts[i]['posted_at']+WINDOW:seen.add(v);pending.append(v)
   if len({posts[k]['author'] for k in seen})<3:continue
   if any(seen<=s for s in sets):continue
   sets=[s for s in sets if not s<seen];sets.append(seen)
  for s in sets:
   members=[posts[i] for i in sorted(s)];proof=[e for (i,j),e in edges.items() if i in s and j in s]
   ids=sorted(r['tweet_id'] for r in members);group_id=hashlib.sha256(('group-v1|'+mint+'|'+'|'.join(ids)).encode()).hexdigest()
   groups.append(dict(id=group_id,mint=mint,token_confirmed=all(x.get('token_status')=='confirmed' for x in members),authors=sorted({x['author'] for x in members}),post_count=len(members),first_at=members[0]['posted_at'],last_at=members[-1]['posted_at'],span_seconds=(members[-1]['posted_at']-members[0]['posted_at'])/1000,edges=proof,members=members))
 groups.sort(key=lambda g:(not g['token_confirmed'],-len(g['authors']),-len(g['edges']),-g['last_at'],g['id']))
 return groups,comparisons

def refresh_groups(db,output,atomic,force=False):
 path=output/'groups.json';stamp=int(time.time()*1000)
 if not force and path.exists() and stamp-path.stat().st_mtime*1000<300000:return
 with db.transaction():
  db.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
  rows=db.execute("SELECT c.tweet_id,c.mint,c.author,c.posted_at,c.source_text,c.source_hash,c.url,c.last_price_status,r.status token_status FROM xc_author_mint_candidates c LEFT JOIN xc_author_mint_registry r USING(mint) WHERE c.active ORDER BY c.mint,c.posted_at,c.tweet_id").fetchall()
  groups,comparisons=detect(rows);shown=groups[:100]
  for g in groups:
   for m in g['members']:
    outcomes=db.execute('SELECT horizon_hours,entry_at,exit_at,entry_usd,exit_usd,gross_return,net_return,evidence_hash FROM xc_author_post_outcomes WHERE tweet_id=%s AND mint=%s AND source_hash=%s',(m['tweet_id'],g['mint'],m['source_hash'])).fetchall()
    m['outcomes']={str(x['horizon_hours']):x for x in outcomes}
    # Reuse verified immutable price data for these exact publication times.
    histories=db.execute('SELECT evidence_hash,proof FROM xc_author_price_evidence WHERE mint=%s AND first_at<=%s AND last_at>=%s ORDER BY fetched_at DESC LIMIT 3',(g['mint'],m['posted_at']+300000,m['posted_at'])).fetchall()
    for h in HORIZONS:
     if str(h) in m['outcomes']:continue
     reason='price_history_missing'
     for history in histories:
      result,reason=evaluate(history['proof'],m['posted_at'],h,stamp)
      if result:m['outcomes'][str(h)]={**result,'horizon_hours':h,'evidence_hash':history['evidence_hash']};break
     if str(h) not in m['outcomes']:m['outcomes'][str(h)]={'reason':reason}
   atomic(output/'groups'/('group-'+g['id']+'.json'),g)
 report=dict(version=1,checked_at=stamp,coverage={'active_address_links':len(rows),'distinct_posts':len({r['tweet_id'] for r in rows}),'tokens_or_address_candidates':len({r['mint'] for r in rows}),'comparisons':comparisons,'groups_found':len(groups),'groups_shown':len(shown),'confirmed_groups':sum(g['token_confirmed'] for g in groups)},groups=[{k:v for k,v in g.items() if k!='members'} for g in shown],method={'window_minutes':15,'minimum_authors':3,'normalization':'NFKC, lower case, remove addresses, URLs and cashtags; text similarity is computed without the shared CA','edge_rule':'5+ shared non-stop words and Jaccard>=0.35 OR character-4gram Dice>=0.45 with 60+ characters OR 2+ shared Latin words of 5+ letters occurring in <=100 unique candidate posts with one word 8+ letters','group_rule':'connected component within a sliding 15-minute window; every member has a qualifying path, not necessarily similarity to every other member; overlapping groups are possible','scope':'all active exact-address candidates from the resumable whole-corpus scan, not only latest posts or top authors','limits':'All candidates and time-qualified pairs are examined. Top 100 groups shown; no semantic translation, media analysis, paid promotion or ownership inference. Unconfirmed addresses can be wallets. Exact stored text may be truncated. Missing price is unknown, never zero. Similarity scores are not probabilities of coordination.'})
 from timing import timing_report
 atomic(output/'timing.json',timing_report(db,groups,stamp))
 from recurring import recurring_analysis
 recurrence=recurring_analysis(groups,rows,stamp)
 atomic(output/'recurring.json',recurrence)
 priority={p['tweet_id'] for cohort in recurrence['trios'][:2] for token in cohort['tokens'][:2] for p in token['posts']}
 atomic(output/'group-price-queue.json',{'tweet_ids':sorted({m['tweet_id'] for g in groups for m in g['members']}),'priority_tweet_ids':sorted(priority)})
 atomic(path,report)
