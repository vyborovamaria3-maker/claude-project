import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
from contextlib import contextmanager
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.auth import require_admin
from app.x_collector_admin import build_x_collector_router

class CollectorApiTest(unittest.TestCase):
    def setUp(self):
        self.app = FastAPI()
        self.app.include_router(build_x_collector_router())
        self.events = []
        self.app.state.audit = SimpleNamespace(record=lambda **event: self.events.append(event))
        self.app.dependency_overrides[require_admin] = lambda: {'sub':'admin'}
        self.client = TestClient(self.app)

    def test_missing_connection_is_explained(self):
        with patch.dict(os.environ, {'ADMIN_X_COLLECTOR_DSN':''}):
            response = self.client.get('/api/x-collector/tables')
        self.assertEqual(response.status_code, 503)
        self.assertIn('ADMIN_X_COLLECTOR_DSN', response.json()['detail'])

    def test_api_requires_admin(self):
        self.app.dependency_overrides[require_admin] = lambda: (_ for _ in ()).throw(__import__('fastapi').HTTPException(401, 'Login required'))
        for method in ('get','post','patch','delete'):
            response = self.client.request(method, '/api/x-collector/tables/x_tasks', **({'json':{'confirm':True}} if method!='get' else {}))
            self.assertEqual(response.status_code, 401)

    def setup_database(self, secret=False):
        meta = {'editable':True, 'columns':[
            {'name':'id','type':'integer','primary_key':True,'sensitive':False,'generated':'','identity':''},
            {'name':'payload','type':'jsonb','primary_key':False,'sensitive':False,'generated':'','identity':''},
        ]}
        class Cursor:
            rowcount=1
            def fetchone(inner):
                return {'id':1,'payload':{'password':'real-secret'} if secret else {'a':1}}
        db = SimpleNamespace(execute=lambda *args: Cursor())
        @contextmanager
        def connection():
            yield db
        return patch('app.x_collector_admin.connection', connection), patch('app.x_collector_admin.metadata', return_value=meta)

    def test_update_requires_confirmation_and_version(self):
        a,b = self.setup_database()
        with a,b:
            for payload in ({'values':{'payload':{'a':2}},'key':{'id':1},'version':'12'}, {'confirm':True,'values':{'payload':{'a':2}},'key':{'id':1}}):
                self.assertEqual(self.client.patch('/api/x-collector/tables/x_tasks',json=payload).status_code,422)
        self.assertTrue(all(not event['success'] for event in self.events))

    def test_masked_json_cannot_overwrite_original_secrets(self):
        a,b = self.setup_database(secret=True)
        with a,b:
            response = self.client.patch('/api/x-collector/tables/x_tasks',json={'confirm':True,'values':{'payload':{'a':2}},'key':{'id':1},'version':'12'})
        self.assertEqual(response.status_code,422)
        self.assertIn('секрет',response.json()['detail'])

    def test_json_redaction_placeholder_rejected(self):
        a,b = self.setup_database()
        with a,b:
            response = self.client.post('/api/x-collector/tables/x_tasks',json={'confirm':True,'values':{'payload':{'a':'••••••'}}})
        self.assertEqual(response.status_code,422)

    def test_success_audited_after_commit(self):
        a,b = self.setup_database()
        @contextmanager
        def commit_failure():
            class Cursor: rowcount=1
            yield SimpleNamespace(execute=lambda *args:Cursor())
            import psycopg
            from fastapi import HTTPException
            raise HTTPException(503,'commit failed') from psycopg.OperationalError('lost')
        with b, patch('app.x_collector_admin.connection',commit_failure):
            response = self.client.post('/api/x-collector/tables/x_tasks',json={'confirm':True,'values':{'payload':{'a':2}}})
        self.assertEqual(response.status_code,503)
        self.assertEqual([event['success'] for event in self.events],[False])

    def test_stale_delete_does_not_report_success(self):
        _, metadata_patch = self.setup_database()
        @contextmanager
        def stale_connection():
            class Cursor: rowcount=0
            yield SimpleNamespace(execute=lambda *args:Cursor())
        with metadata_patch, patch('app.x_collector_admin.connection',stale_connection):
            response = self.client.request('DELETE','/api/x-collector/tables/x_tasks',json={'confirm':True,'key':{'id':1},'version':'12'})
        self.assertEqual(response.status_code,409)
        self.assertEqual([event['success'] for event in self.events],[False])

    def test_sql_identifier_injection_cannot_select_a_table(self):
        @contextmanager
        def empty_connection():
            class Cursor:
                def fetchall(self): return []
            yield SimpleNamespace(execute=lambda *args:Cursor())
        with patch('app.x_collector_admin.connection',empty_connection):
            response = self.client.get('/api/x-collector/tables/x_tasks%22%3BDELETE%20FROM%20x_tasks')
        self.assertEqual(response.status_code,404)
