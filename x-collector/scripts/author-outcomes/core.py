"""Exact Solana address candidates and immutable USD candle evidence. No LLM calls."""
import hashlib,json,math,re,time,urllib.request,urllib.error
from datetime import datetime
ALPHABET='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
ADDRESS=re.compile(r'(?<![A-Za-z0-9_])([1-9A-HJ-NP-Za-km-z]{32,44})(?![A-Za-z0-9_])')
ROOT='https://api.geckoterminal.com/api/v2/networks/solana'
INTERVAL=300000
TOLERANCE=300000
HORIZONS=(1,24,72)
def valid_address(value):
 if not isinstance(value,str) or not re.fullmatch('[1-9A-HJ-NP-Za-km-z]{32,44}',value):return False
 n=0
 for c in value:n=n*58+ALPHABET.index(c)
 return (len(value)-len(value.lstrip('1')))+(n.bit_length()+7)//8==32

def addresses(text):return sorted({m for m in ADDRESS.findall(text or '') if valid_address(m)})
def stable(value):return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False)
def digest(value):return hashlib.sha256(stable(value).encode()).hexdigest()
def text_hash(text):return hashlib.sha256(text.encode()).hexdigest()
def evaluate(proof,posted_at,horizon,now):
 if horizon not in HORIZONS:raise ValueError('invalid_horizon')
 if proof.get('source')!='geckoterminal' or proof.get('currency')!='usd' or proof.get('interval_ms')!=INTERVAL:raise ValueError('invalid_evidence')
 # First observed open at/after publication, never a preceding candle close.
 points=sorted(proof['candles'],key=lambda x:x[0]);entry=next((x for x in points if posted_at<=x[0]<=posted_at+TOLERANCE and x[1]>0 and x[5]>0),None)
 if not entry:return None,'entry_price_missing'
 target=entry[0]+horizon*3600000
 if now<target+INTERVAL:return None,'immature'
 exit=next((x for x in points if target<=x[0]<=target+TOLERANCE and x[1]>0 and x[5]>0),None)
 if not exit:return None,'future_price_missing'
 if exit[0]+INTERVAL>proof['fetched_at'] or proof['fetched_at']>now:return None,'unclosed_candle'
 gross=exit[1]/entry[1]-1
 net=(exit[1]*.99)/(entry[1]*1.01)-1
 return dict(entry_at=entry[0],exit_at=exit[0],entry_usd=entry[1],exit_usd=exit[1],gross_return=gross,net_return=net,entry_volume_usd=entry[5],exit_volume_usd=exit[5],price_quality='thin_candle' if min(entry[5],exit[5])<100 else 'observed_price'),None

class PriceSource:
 def __init__(self,fetch=None,clock=lambda:int(time.time()*1000),sleep=time.sleep):
  self.clock=clock;self.sleep=sleep;self.fetch=fetch or self._fetch;self.last=0
 def _fetch(self,url):
  req=urllib.request.Request(url,headers={'Accept':'application/json','User-Agent':'POTAPoff-AuthorEvaluation/1'})
  try:
   with urllib.request.urlopen(req,timeout=20) as response:
    if response.status!=200:raise ValueError('price_http_error')
    raw=response.read(8*1024*1024+1)
    if len(raw)>8*1024*1024:raise ValueError('oversized_price_response')
    return json.loads(raw)
  except urllib.error.HTTPError as e:
   raise ValueError('price_rate_limited' if e.code==429 else 'price_http_error') from None
  except (OSError,ValueError):raise ValueError('price_source_unavailable') from None
 def request(self,url):
  delay=max(0,7000-(self.clock()-self.last))
  if delay:self.sleep(delay/1000)
  self.last=self.clock();return self.fetch(url)
 def history(self,mint,posted_at):
  if not valid_address(mint):raise ValueError('invalid_mint')
  lookup=ROOT+'/tokens/'+mint+'/pools?page=1';data=self.request(lookup);pools=[]
  for p in data.get('data',[]):
   address=p.get('attributes',{}).get('address');rels=p.get('relationships',{})
   if p.get('type')!='pool' or p.get('id')!='solana_'+str(address) or not valid_address(address):continue
   base=rels.get('base_token',{}).get('data',{});quote=rels.get('quote_token',{}).get('data',{})
   if any(x.get('type')!='token' or not valid_address(x.get('id','').removeprefix('solana_')) or not x.get('id','').startswith('solana_') for x in (base,quote)):continue
   side='base' if base['id']=='solana_'+mint else 'quote' if quote['id']=='solana_'+mint else None
   if side:pools.append((float(p.get('attributes',{}).get('reserve_in_usd') or 0),address,side,p))
  if not pools:raise ValueError('token_pool_not_confirmed')
  eligible=[]
  for candidate in pools:
   try:created=int(datetime.fromisoformat(candidate[3]['attributes']['pool_created_at'].replace('Z','+00:00')).timestamp()*1000)
   except (ValueError,KeyError,TypeError):continue
   if created<=posted_at:eligible.append(candidate)
  _,pool,side,p=max(eligible or pools,key=lambda x:(x[0],x[1]));pool_at=self.clock()
  # 1000 five-minute candles cover 83h; anchor the window to this signal.
  before=min(self.clock()//1000,(posted_at+73*3600000)//1000)
  url=ROOT+'/pools/'+pool+'/ohlcv/minute?aggregate=5&limit=1000&currency=usd&token='+side+'&include_empty_intervals=false&before_timestamp='+str(before)
  payload=self.request(url);fetched=self.clock();meta=payload.get('meta',{})
  for token_side in ('base','quote'):
   if meta.get(token_side,{}).get('address')!=p['relationships'][token_side+'_token']['data']['id'].removeprefix('solana_'):raise ValueError('token_identity_mismatch')
  if payload.get('data',{}).get('type')!='ohlcv_request_response':raise ValueError('invalid_candles')
  raw=payload.get('data',{}).get('attributes',{}).get('ohlcv_list')
  if not isinstance(raw,list):raise ValueError('invalid_candles')
  candles=[];seen=set()
  for row in raw:
   if not isinstance(row,list) or len(row)<6 or any(isinstance(x,bool) or not isinstance(x,(float,int)) or not math.isfinite(x) for x in row[:6]):raise ValueError('invalid_candle')
   t,o,h,l,c,v=row[:6];ts=int(t*1000)
   if ts%INTERVAL or ts in seen or min(o,h,l,c)<=0 or v<0 or h<max(o,l,c) or l>min(o,h,c):raise ValueError('invalid_candle')
   seen.add(ts)
   if ts+INTERVAL<=fetched:candles.append([ts,o,h,l,c,v])
  proof=dict(version=1,source='geckoterminal',network='solana',currency='usd',mint=mint,pool=pool,token_side=side,interval_ms=INTERVAL,fetched_at=fetched,pool_observed_at=pool_at,lookup_url=lookup,request_url=url,pool_record=p,ohlcv_meta=meta,candles=sorted(candles))
  return proof
