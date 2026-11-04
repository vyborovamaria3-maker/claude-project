import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from fastapi import HTTPException
from app.fomo_evaluation import evaluation_report, evaluation_evidence

class FomoEvaluationTests(unittest.TestCase):
 def test_real_shape_projection_is_bounded_and_read_only(self):
  with tempfile.TemporaryDirectory() as tmp:
   path=Path(tmp)/'trade.db'
   with sqlite3.connect(path) as db:
    db.executescript("""
     CREATE TABLE fomo_score_snapshots(snapshot_id TEXT,mint TEXT,signal_at INTEGER,score_version TEXT,fomo_pressure REAL,fomo_quality REAL,quality_coverage REAL,x_sample_count INTEGER,tg_sample_count INTEGER,source_meta_json TEXT,snapshot_sha256 TEXT);
     CREATE TABLE fomo_local_worker(id INTEGER,last_tick_at INTEGER,last_capture_at INTEGER,last_outcome_at INTEGER,next_capture_at INTEGER,next_outcome_at INTEGER,last_error TEXT);
     CREATE TABLE fomo_price_outcomes(snapshot_id TEXT,horizon_hours INTEGER,timeframe TEXT,completed_at INTEGER,evidence_sha256 TEXT,labelled_json TEXT,snapshot_sha256 TEXT);
     CREATE TABLE fomo_price_evidence(sha256 TEXT,payload_json TEXT);
     CREATE TABLE fomo_price_attempts(horizon_hours INTEGER,status TEXT,reason TEXT);
    """)
    db.execute('INSERT INTO fomo_score_snapshots VALUES(?,?,?,?,?,?,?,?,?,?,?)',('s','mint',1000,'local',20,30,0.075,0,2,'{}','hash'))
    label={'signalAt':'2026-10-27T00:00:00Z','outcomeAt':'2026-10-27T01:00:00Z','forwardReturnPct':5,'maxDrawdownPct':-3}
    db.execute('INSERT INTO fomo_price_outcomes VALUES(?,?,?,?,?,?,?)',('s',1,'5m',4000000,'evidence',json.dumps(label),'hash'))
    db.execute('INSERT INTO fomo_price_evidence VALUES(?,?)',('evidence',json.dumps({'source':'geckoterminal','priceUnit':'USD','candles':[]})))
   db.close()
   before=path.read_bytes()
   report=evaluation_report(str(path),now=7201000)
   self.assertEqual(report['summary']['snapshots'],1)
   self.assertEqual(report['horizons'][0]['labelled'],1)
   self.assertEqual(report['horizons'][1]['immature'],1)
   self.assertTrue(report['worker_stale'])
   self.assertEqual(report['outcomes'][0]['forwardReturnPct'],5)
   self.assertEqual(evaluation_evidence(str(path),'s',1)['unit'],'USD')
   with self.assertRaises(HTTPException) as missing:evaluation_evidence(str(path),"s' OR 1=1--",1)
   self.assertEqual(missing.exception.status_code,404)
   self.assertEqual(path.read_bytes(),before)
   with sqlite3.connect(path) as db:db.execute("UPDATE fomo_score_snapshots SET snapshot_sha256='changed'")
   db.close()
   with self.assertRaises(HTTPException) as changed:evaluation_evidence(str(path),'s',1)
   self.assertEqual(changed.exception.status_code,409)
 def test_archive_download_fails_closed_if_bytes_change(self):
  import hashlib
  import os
  from unittest.mock import patch
  from app.fomo_evaluation import build_fomo_evaluation_router
  endpoint=next(r.endpoint for r in build_fomo_evaluation_router().routes if r.path.endswith('/token-chain-evidence'))
  with tempfile.TemporaryDirectory() as tmp:
   evidence=Path(tmp)/'evidence.jsonl';report=Path(tmp)/'report.json'
   data=b'["stored-chain-v1","mint"]\n'
   evidence.write_bytes(data)
   report.write_text(json.dumps({'version':'multisource-token-check-v1','chainAssessment':{'datasetHash':hashlib.sha256(data).hexdigest()}}),encoding='utf8')
   with patch.dict(os.environ,{'ADMIN_TOKEN_CHECK_REPORT':str(report),'ADMIN_TOKEN_CHAIN_EVIDENCE':str(evidence)}):
    self.assertEqual(endpoint().body,data)
    evidence.write_bytes(data+b'changed')
    with self.assertRaises(HTTPException) as changed:endpoint()
    self.assertEqual(changed.exception.status_code,409)
 def test_missing_database_fails_without_creating_it(self):
  with tempfile.TemporaryDirectory() as tmp:
   path=Path(tmp)/'missing.db'
   with self.assertRaises(HTTPException) as missing:evaluation_report(str(path))
   self.assertEqual(missing.exception.status_code,503)
   self.assertFalse(path.exists())

if __name__=='__main__':unittest.main()
