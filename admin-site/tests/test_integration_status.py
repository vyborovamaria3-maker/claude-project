import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from app.auth import require_admin
from app.integration_status import build_integration_router, collector_status
from app.twitter_monitoring_api import _backend_settings_url


class IntegrationStatusTest(unittest.TestCase):
    def setUp(self):
        app = FastAPI()
        app.include_router(build_integration_router())
        app.state.mutable_state_backend = 'sqlite'
        app.dependency_overrides[require_admin] = lambda: {'sub': 'admin'}
        self.app = app
        self.client = TestClient(app)

    def test_unavailable_services_are_reported_without_credentials(self):
        with patch('app.integration_status.connection', side_effect=HTTPException(503, 'secret-dsn')), patch('app.integration_status._backend_request', new=AsyncMock(side_effect=HTTPException(503, 'secret-key'))):
            response = self.client.get('/api/integrations')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()['rows']), 4)
        self.assertNotIn('secret-', response.text)
        self.assertIn('Недоступно', response.text)
        self.assertIn('сайт флаги и профили не читает', response.text)

    def test_invalid_backend_success_is_not_reported_as_available(self):
        with patch('app.integration_status.collector_status', return_value='Чтение доступно'), patch('app.integration_status._backend_request', new=AsyncMock(return_value={})):
            response = self.client.get('/api/integrations')
        self.assertIn('Недоступно', response.json()['rows'][0]['Состояние'])

    def test_collector_checks_table_permissions(self):
        db = MagicMock()
        db.execute.side_effect = HTTPException(503, 'permission denied')
        connection = MagicMock()
        connection.__enter__.return_value = db
        connection.__exit__.return_value = False
        with patch('app.integration_status.connection', return_value=connection):
            self.assertIn('Недоступно', collector_status())
        db.execute.assert_called_once_with('SELECT 1 FROM public.x_tasks LIMIT 0')

    def test_requires_login(self):
        self.app.dependency_overrides[require_admin] = lambda: (_ for _ in ()).throw(HTTPException(401))
        self.assertEqual(self.client.get('/api/integrations').status_code, 401)

    def test_twitter_uses_main_site_url_unless_overridden(self):
        with patch.dict('os.environ', {'POTAPOFF_BACKEND_URL': 'http://localhost:8001/'}, clear=True):
            self.assertEqual(_backend_settings_url(), 'http://localhost:8001/api/v1/twitter/admin/crawler-settings')
        with patch.dict('os.environ', {'POTAPOFF_BACKEND_URL': 'http://localhost:8001', 'ADMIN_TWITTER_BACKEND_URL': 'http://other:9000/'}, clear=True):
            self.assertEqual(_backend_settings_url(), 'http://other:9000/api/v1/twitter/admin/crawler-settings')
