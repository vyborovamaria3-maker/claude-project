import os
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.auth import require_admin
from app.tg_collector_admin import build_tg_collector_router, upstream

class TGCollectorTests(unittest.TestCase):
    def setUp(self):
        self.app = FastAPI()
        self.app.include_router(build_tg_collector_router())
        self.app.dependency_overrides[require_admin] = lambda: {"sub": "test-admin"}
        self.client = TestClient(self.app)

    def test_auth_required(self):
        def reject(): raise HTTPException(401)
        self.app.dependency_overrides[require_admin] = reject
        self.assertEqual(self.client.get("/api/tg-collector").status_code, 401)
        self.assertEqual(self.client.post("/api/tg-collector", json={"action":"stop"}).status_code, 401)

    def test_snapshot_masks_proxy_and_forwards_filter(self):
        with patch("app.tg_collector_admin.upstream", new_callable=AsyncMock) as call:
            call.return_value = {"stats":{"messages":523}, "messages":[{"text":"hello"}], "proxy":{"enabled":True,"type":"socks5","password":"hidden-canary","host":"hidden-host"}, "session":"hidden-session"}
            r = self.client.get("/api/tg-collector?q=hello&source=12&page=2")
            self.assertEqual(r.status_code,200)
            self.assertEqual(r.json()["stats"]["messages"],523)
            self.assertNotIn("hidden-",r.text)
            self.assertIn("no-store", r.headers["cache-control"])
            call.assert_awaited_once_with("GET", params={"q":"hello","source":"12","page":2})

    def test_control_requires_exact_origin(self):
        with patch("app.tg_collector_admin.upstream", new_callable=AsyncMock) as call:
            for origin in (None,"https://attacker.invalid"):
                headers = {"Origin":origin} if origin else {}
                self.assertEqual(self.client.post("/api/tg-collector",headers=headers,json={"action":"stop"}).status_code,403)
            call.assert_not_awaited()

    def test_start_stop(self):
        with patch("app.tg_collector_admin.upstream", new_callable=AsyncMock) as call:
            for action in ("stop","start"):
                call.return_value = {"collectionEnabled":action == "start"}
                r = self.client.post("/api/tg-collector",headers={"Origin":"http://testserver"},json={"action":action})
                self.assertEqual(r.status_code,200)
                self.assertEqual(r.json()["collectionEnabled"],action == "start")
                call.assert_awaited_with("POST", body={"action":action})

    def test_rejects_other_actions_and_invalid_filters(self):
        self.assertEqual(self.client.post("/api/tg-collector",json={"action":"proxy-save"}).status_code,422)
        for query in ("page=-1","page=101","source=bad"):
            self.assertEqual(self.client.get("/api/tg-collector?"+query).status_code,422)

    def test_discovery_settings_limits_and_origin(self):
        body = {"messageSearchEnabled":False,"messageTerms":["PNUT","Peanut the Squirrel","2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump"],"pumpEnabled":False,"pumpMinAthUsd":100000,"pumpMaxTokens":3,"pumpQueries":[],"enabled":True,"keywords":["memecoin","solana"],"intervalMinutes":60,
                "resultsPerQuery":10,"queriesPerCycle":1,"maxQueriesPerDay":24,
                "maxNewPerDay":3,"maxSources":30,"autoKeywordsEnabled":True,"autoKeywordsLimit":12,
                "twitterLookbackHours":72,"twitterTweetLimit":2000,"minKeywordPosts":3,"minKeywordAuthors":2}
        with patch("app.tg_collector_admin.upstream", new_callable=AsyncMock) as call:
            call.return_value = {"ok":True}
            self.assertEqual(self.client.post("/api/tg-collector/discovery",json=body).status_code,403)
            for changes in ({"maxNewPerDay":101},{"maxSources":0},{"keywords":["x"]},{"queriesPerCycle":True},{"autoKeywordsEnabled":False,"keywords":[]}):
                self.assertEqual(self.client.post("/api/tg-collector/discovery",headers={"Origin":"http://testserver"},json=body|changes).status_code,422)
            self.assertEqual(self.client.post("/api/tg-collector/discovery",headers={"Origin":"http://testserver"},json=body).status_code,200)
            call.assert_awaited_once_with("POST",suffix="/discovery",body=body)

    def test_discovery_requires_admin(self):
        self.app.dependency_overrides[require_admin] = lambda: (_ for _ in ()).throw(HTTPException(401))
        self.assertEqual(self.client.get("/api/tg-collector/discovery").status_code,401)

    def test_upstream_errors_do_not_expose_secrets(self):
        import asyncio, httpx
        with patch("app.tg_collector_admin.collector_token",return_value="test-only-placeholder-value"), patch("httpx.AsyncClient.request", new_callable=AsyncMock, side_effect=httpx.ConnectError("hidden-canary")):
            with self.assertRaises(HTTPException) as caught: asyncio.run(upstream("GET"))
            self.assertNotIn("hidden-canary",caught.exception.detail)

if __name__ == "__main__": unittest.main()
