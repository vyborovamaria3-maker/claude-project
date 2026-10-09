import sys
import unittest
from pathlib import Path
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from app.auth import require_admin
from app.social_agent_api import build_social_agent_router

class SocialAgentApiTest(unittest.TestCase):
    def setUp(self):
        app=FastAPI();app.include_router(build_social_agent_router())
        self.events=[];app.state.audit=SimpleNamespace(record=lambda **kw:self.events.append(kw))
        app.dependency_overrides[require_admin]=lambda:{'sub':'admin'}
        self.app=app;self.client=TestClient(app)

    def database(self,changed=1,stopped=False,commit_fail=False,command_id=1):
        class Db:
            def execute(inner,query,params=None):
                if 'to_regclass' in query:return SimpleNamespace(fetchone=lambda:{'commands':True})
                if 'SELECT stopped' in query:return SimpleNamespace(fetchone=lambda:{'stopped':stopped})
                if 'INSERT INTO social_agent_commands' in query:return SimpleNamespace(fetchone=lambda:{'id':command_id} if command_id else None)
                return SimpleNamespace(rowcount=changed)
        @contextmanager
        def connection():
            yield Db()
            if commit_fail:raise HTTPException(503,'commit failed')
        return patch('app.social_agent_api.connection',connection)

    def test_requires_admin(self):
        def denied():raise HTTPException(401,'Login required')
        self.app.dependency_overrides[require_admin]=denied
        self.assertEqual(self.client.get('/api/social-agent/state').status_code,401)
        self.assertEqual(self.client.put('/api/social-agent/control',json={'stopped':True}).status_code,401)

    def test_limits_validate_bounds(self):
        for data in [{'per_cycle':11,'per_day':12,'version':'1'},{'per_cycle':1,'per_day':0,'version':'1'},{'per_cycle':1,'per_day':12,'version':'unsafe'}]:
            self.assertEqual(self.client.put('/api/social-agent/limits',json=data).status_code,422)

    def test_concurrent_settings_update_rejected(self):
        with self.database(changed=0):
            self.assertEqual(self.client.put('/api/social-agent/limits',json={'per_cycle':3,'per_day':12,'version':'1'}).status_code,409)
        self.assertEqual(self.events,[])

    def test_stop_success_audited_after_commit(self):
        with self.database():self.assertEqual(self.client.put('/api/social-agent/control',json={'stopped':True}).status_code,200)
        self.assertEqual(self.events[0]['details'],{'stopped':True})

    def test_failed_commit_not_reported_as_success(self):
        with self.database(commit_fail=True):self.assertEqual(self.client.put('/api/social-agent/control',json={'stopped':True}).status_code,503)
        self.assertEqual(self.events,[])

    def test_busy_or_stale_account_rejected(self):
        with self.database(changed=0):self.assertEqual(self.client.put('/api/social-agent/accounts/reader/role',json={'role':'publisher','version':'1'}).status_code,409)

    def test_unknown_roles_and_commands_rejected(self):
        self.assertEqual(self.client.put('/api/social-agent/accounts/reader/role',json={'role':'admin','version':'1'}).status_code,422)
        self.assertEqual(self.client.post('/api/social-agent/commands',json={'kind':'shell'}).status_code,422)

    def test_stopped_agent_rejects_commands(self):
        with self.database(stopped=True):self.assertEqual(self.client.post('/api/social-agent/commands',json={'kind':'run'}).status_code,409)

    def test_duplicate_pending_command_rejected(self):
        with self.database(command_id=None):self.assertEqual(self.client.post('/api/social-agent/commands',json={'kind':'run'}).status_code,409)

    def test_command_accepted_with_queue_id(self):
        with self.database():r=self.client.post('/api/social-agent/commands',json={'kind':'discover'})
        self.assertEqual(r.status_code,202);self.assertEqual(r.json()['id'],1)
