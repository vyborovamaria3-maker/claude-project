"""Read-only UI for exact-address author markouts; authenticated and immutable evidence."""
import json,os,re,hashlib
from pathlib import Path
from fastapi import APIRouter,Depends,HTTPException,Response
from .auth import require_admin

def build_author_outcomes_router():
 router=APIRouter(prefix='/api/author-outcomes',dependencies=[Depends(require_admin)])
 def directory():
  value=os.environ.get('AUTHOR_OUTCOMES_DIRECTORY')
  if not value:raise HTTPException(503,'Оценка авторов ещё не настроена')
  return Path(value)
 @router.get('')
 def report(response:Response):
  response.headers['Cache-Control']='private, no-store'
  try:
   p=directory()/'report.json'
   if p.stat().st_size>8*1024*1024:raise ValueError()
   return json.loads(p.read_text(encoding='utf8'))
  except (OSError,ValueError):raise HTTPException(503,'Первый проход по базе ещё не завершён') from None
 @router.get('/groups-timing')
 def timing_report(response:Response):
  response.headers['Cache-Control']='private, no-store'
  try:
   p=directory()/'timing.json'
   if p.stat().st_size>8*1024*1024:raise ValueError()
   return json.loads(p.read_text(encoding='utf8'))
  except (OSError,ValueError):raise HTTPException(503,'Историческое сопоставление ещё выполняется') from None
 @router.get('/groups-recurring')
 def recurring_report(response:Response):
  response.headers['Cache-Control']='private, no-store'
  try:
   p=directory()/'recurring.json'
   if p.stat().st_size>8*1024*1024:raise ValueError()
   return json.loads(p.read_text(encoding='utf8'))
  except (OSError,ValueError):raise HTTPException(503,'Сопоставление групп ещё выполняется') from None
 @router.get('/groups')
 def groups_report(response:Response):
  response.headers['Cache-Control']='private, no-store'
  try:
   p=directory()/'groups.json'
   if p.stat().st_size>8*1024*1024:raise ValueError()
   return json.loads(p.read_text(encoding='utf8'))
  except (OSError,ValueError):raise HTTPException(503,'Первый поиск групп ещё выполняется') from None
 @router.get('/groups/{group_id}')
 def group_evidence(group_id:str,response:Response):
  if not re.fullmatch('[0-9a-f]{64}',group_id):raise HTTPException(404,'Группа не найдена')
  response.headers['Cache-Control']='private, no-store'
  try:
   p=directory()/'groups'/('group-'+group_id+'.json')
   if p.stat().st_size>8*1024*1024:raise ValueError()
   data=json.loads(p.read_text(encoding='utf8'))
   expected=hashlib.sha256(('group-v1|'+data['mint']+'|'+'|'.join(sorted(x['tweet_id'] for x in data['members']))).encode()).hexdigest()
   if expected!=group_id or data['id']!=group_id:raise ValueError()
   for m in data['members']:
    if hashlib.sha256(m['source_text'].encode()).hexdigest()!=m['source_hash']:raise ValueError()
   return data
  except (OSError,ValueError,KeyError,TypeError):raise HTTPException(404,'Доказательство группы недоступно или повреждено') from None
 @router.get('/evidence/{sha}')
 def evidence(sha:str,response:Response):
  if not re.fullmatch('[0-9a-f]{64}',sha):raise HTTPException(404,'Доказательство не найдено')
  response.headers['Cache-Control']='private, no-store'
  try:
   p=directory()/'evidence'/('author-'+sha+'.json')
   if p.stat().st_size>8*1024*1024:raise ValueError()
   data=json.loads(p.read_text(encoding='utf8'))
   canonical=json.dumps(data,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False)
   if hashlib.sha256(canonical.encode()).hexdigest()!=sha:raise ValueError()
   return data
  except (OSError,ValueError):raise HTTPException(404,'Доказательство недоступно или повреждено') from None
 return router
