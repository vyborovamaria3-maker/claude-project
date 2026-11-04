"""Deduplicated cross-CA recurrence of direct similarity edges and author triangles."""
from collections import defaultdict
from itertools import combinations
from statistics import median

def recurring_analysis(groups,rows,stamp):
 by_id={g['id']:g for g in groups};pairs=defaultdict(lambda:defaultdict(dict));triangles=defaultdict(lambda:defaultdict(set));account_mints=defaultdict(set)
 for r in rows:account_mints[r['author']].add(r['mint'])
 for g in groups:
  posts={m['tweet_id']:m for m in g['members']};direct=set()
  for e in g['edges']:
   key=tuple(sorted((posts[e['a']]['author'],posts[e['b']]['author'])))
   if key[0]==key[1]:continue
   direct.add(key);edge_key=tuple(sorted((e['a'],e['b'])))
   proof=dict(group_id=g['id'],mint=g['mint'],a=e['a'],b=e['b'],gap_seconds=e['gap_seconds'],word_jaccard=e['word_jaccard'],character_dice=e['character_dice'],anchors=e['anchors'],at=min(posts[e['a']]['posted_at'],posts[e['b']]['posted_at']))
   pairs[key][g['mint']][edge_key]=proof
  for authors in combinations(g['authors'],3):
   if all(tuple(sorted(p)) in direct for p in combinations(authors,2)):triangles[authors][g['mint']].add(g['id'])
 def token_summary(mint,ids,authors):
  candidates=[by_id[i] for i in ids];g=min(candidates,key=lambda g:(g['span_seconds'],g['id']))
  members=[m for m in g['members'] if m['author'] in authors];wanted={m['tweet_id'] for m in members}
  return dict(mint=mint,token_confirmed=g['token_confirmed'],group_id=g['id'],first_at=g['first_at'],span_seconds=g['span_seconds'],groups_for_this_ca=len(set(ids)),posts=[dict(tweet_id=m['tweet_id'],author=m['author'],posted_at=m['posted_at'],outcomes=m.get('outcomes',{})) for m in members],edges=[e for e in g['edges'] if e['a'] in wanted and e['b'] in wanted])
 pair_rows=[]
 for authors,mints in pairs.items():
  if len(mints)<2:continue
  edges=[e for per_mint in mints.values() for e in per_mint.values()]
  evidence=[]
  for mint,proofs in mints.items():
   item=token_summary(mint,{e['group_id'] for e in proofs.values()},authors)
   item['minimum_pair_gap_seconds']=min(e['gap_seconds'] for e in proofs.values());item['median_pair_gap_seconds']=median(e['gap_seconds'] for e in proofs.values());evidence.append(item)
  pair_rows.append(dict(authors=list(authors),distinct_ca=len(mints),confirmed_ca=sum(t['token_confirmed'] for t in evidence),utc_days=len({e['at']//86400000 for e in edges}),unique_post_pairs=len(edges),median_per_ca_gap_seconds=median(t['median_pair_gap_seconds'] for t in evidence),author_total_ca={a:len(account_mints[a]) for a in authors},tokens=sorted(evidence,key=lambda x:(not x['token_confirmed'],x['first_at'],x['mint']))))
 pair_rows.sort(key=lambda x:(-x['distinct_ca'],-x['utc_days'],x['median_per_ca_gap_seconds'],x['authors']))
 trio_rows=[]
 for authors,mints in triangles.items():
  if len(mints)<2:continue
  tokens=[token_summary(mint,ids,authors) for mint,ids in mints.items()]
  trio_rows.append(dict(authors=list(authors),distinct_ca=len(mints),confirmed_ca=sum(t['token_confirmed'] for t in tokens),utc_days=len({by_id[i]['first_at']//86400000 for ids in mints.values() for i in ids}),tokens=sorted(tokens,key=lambda x:(not x['token_confirmed'],x['first_at'],x['mint']))))
 trio_rows.sort(key=lambda x:(-x['distinct_ca'],-x['utc_days'],x['authors']))
 strength={tuple(x['authors']):x['distinct_ca'] for x in pair_rows};ranked=[]
 for g in groups:
  posts={m['tweet_id']:m for m in g['members']};direct={tuple(sorted((posts[e['a']]['author'],posts[e['b']]['author']))) for e in g['edges']}
  repeated={p:strength[p] for p in direct if p in strength}
  ranked.append(dict(group_id=g['id'],mint=g['mint'],authors=g['authors'],span_seconds=g['span_seconds'],token_confirmed=g['token_confirmed'],maximum_repeated_pair_ca=max(repeated.values(),default=1),recurring_pairs=len(repeated),reasons=['Directly similar author pairs recur on other addresses'] if repeated else ['Only one-address evidence; cross-address recurrence not established']))
 ranked.sort(key=lambda x:(-x['maximum_repeated_pair_ca'],-x['recurring_pairs'],x['span_seconds'],x['group_id']))
 account_rows=[]
 for author in sorted(account_mints):
  involved=[p for p in pair_rows if author in p['authors']]
  if not involved:continue
  account_rows.append(dict(author=author,partners=sorted({a for p in involved for a in p['authors'] if a!=author}),recurrent_partner_count=len(involved),distinct_recurrent_ca=len({t['mint'] for p in involved for t in p['tokens']}),total_candidate_ca=len(account_mints[author])))
 account_rows.sort(key=lambda x:(-x['distinct_recurrent_ca'],-x['recurrent_partner_count'],x['author']))
 available={}
 for g in groups:
  for m in g['members']:
   for h,o in m.get('outcomes',{}).items():
    if o.get('net_return') is not None:available[m['tweet_id'],g['mint'],h]=dict(group_id=g['id'],mint=g['mint'],author=m['author'],tweet_id=m['tweet_id'],horizon_hours=int(h),**{k:v for k,v in o.items() if k!='horizon_hours'})
 return dict(version=1,checked_at=stamp,coverage=dict(groups_analyzed=len(groups),distinct_ca=len({g['mint'] for g in groups}),recurrent_pairs=len(pair_rows),recurrent_triangles=len(trio_rows),recurrent_accounts=len(account_rows),priced_post_horizons=len(available)),pairs=pair_rows,trios=trio_rows,accounts=account_rows,ranked_groups=ranked,priced_examples=list(available.values())[:60],method={'support':'number of distinct exact addresses; same address and overlapping windows count once','pair':'direct qualified time/text edge in a detected group; membership through a third author is insufficient','trio':'all three author pairs have direct time/text edges inside each supporting group; different posts by one author can support its two edges','ranking':'descriptive check priority: distinct CA support, UTC days, then time gaps; no fraud probability or significance test','baseline':'author_total_ca counts all addresses in that author\'s candidate posts, to expose activity bias','limitations':'Unknown addresses are not confirmed tokens. Repetition can mean shared templates, syndication or a common news source. No proof of payment, ownership or executed pump/dump. No control for popularity/activity beyond displaying baseline. Prices missing for a group are unknown; examples with available prices do not represent all groups. Prices are per publication, not independent per group or author PNL.'})
