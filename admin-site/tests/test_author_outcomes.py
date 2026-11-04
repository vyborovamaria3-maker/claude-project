import hashlib,json,os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from fastapi import HTTPException,Response
from app.author_outcomes import build_author_outcomes_router
class Tests(unittest.TestCase):
 def test_missing_report_and_hash_tamper_fail_closed(self):
  routes=build_author_outcomes_router().routes;report=next(r.endpoint for r in routes if r.path=='/api/author-outcomes');evidence=next(r.endpoint for r in routes if '/evidence/' in r.path)
  with tempfile.TemporaryDirectory() as d,patch.dict(os.environ,{'AUTHOR_OUTCOMES_DIRECTORY':d}):
   with self.assertRaises(HTTPException):report(Response())
   obj={'source':'geckoterminal','candles':[[1,2]]};raw=json.dumps(obj,sort_keys=True,separators=(',',':'),ensure_ascii=False);sha=hashlib.sha256(raw.encode()).hexdigest();folder=Path(d)/'evidence';folder.mkdir();p=folder/('author-'+sha+'.json');p.write_text(raw,encoding='utf8')
   response=Response();self.assertEqual(evidence(sha,response),obj);self.assertIn('no-store',response.headers['Cache-Control']);p.write_text('{}',encoding='utf8')
   with self.assertRaises(HTTPException):evidence(sha,Response())
   with self.assertRaises(HTTPException):evidence('../report',Response())
 def test_group_proof_is_bound_to_members_and_text_hash(self):
  routes=build_author_outcomes_router().routes;endpoint=next(r.endpoint for r in routes if r.path.endswith('/groups/{group_id}'))
  member={'tweet_id':'1','source_text':'evidence'};member['source_hash']=hashlib.sha256(member['source_text'].encode()).hexdigest();group_id=hashlib.sha256(b'group-v1|mint|1').hexdigest();data={'id':group_id,'mint':'mint','members':[member]}
  with tempfile.TemporaryDirectory() as d,patch.dict(os.environ,{'AUTHOR_OUTCOMES_DIRECTORY':d}):
   directory=Path(d)/'groups';directory.mkdir();path=directory/('group-'+group_id+'.json');path.write_text(json.dumps(data),encoding='utf8')
   self.assertEqual(endpoint(group_id,Response())['members'][0]['tweet_id'],'1');member['source_text']='tampered';path.write_text(json.dumps(data),encoding='utf8')
   with self.assertRaises(HTTPException):endpoint(group_id,Response())
   with self.assertRaises(HTTPException):endpoint('../report',Response())
if __name__=='__main__':unittest.main()
