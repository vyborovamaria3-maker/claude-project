import pytest

from app.services.social_refresh import refresh_x_for_mint_authenticated


class FakeResponse:
    def raise_for_status(self):
        return None

    def json(self):
        return {
            "symbol": "TEST",
            "twitterHandle": "test_handle",
            "topTweets": [
                {
                    "author": "caller",
                    "text": "signal",
                    "timestamp": 1_700_000_000_000,
                    "likes": 12,
                    "retweets": 3,
                    "views": 400,
                    "isSuspicious": False,
                }
            ],
        }


class FakeAsyncClient:
    last_call = None

    def __init__(self, *args, **kwargs):
        self.args = args
        self.kwargs = kwargs

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def get(self, url, *, params=None, headers=None):
        type(self).last_call = {
            "url": url,
            "params": params,
            "headers": headers,
        }
        return FakeResponse()


@pytest.mark.asyncio
async def test_social_refresh_sends_backend_api_key(monkeypatch):
    monkeypatch.setattr(
        "app.services.social_refresh.httpx.AsyncClient",
        FakeAsyncClient,
    )

    payload = await refresh_x_for_mint_authenticated(
        backend_frontend_url="http://frontend:3000/",
        mint_address="11111111111111111111111111111111",
        backend_api_key="k" * 32,
    )

    call = FakeAsyncClient.last_call
    assert call is not None
    assert call["url"] == "http://frontend:3000/api/trade/dev-twitter"
    assert call["params"] == {
        "mint": "11111111111111111111111111111111",
        "strategy": "auto",
    }
    assert call["headers"] == {"X-Backend-API-Key": "k" * 32}
    assert payload["token_mint"] == "11111111111111111111111111111111"
    assert payload["token_symbol"] == "TEST"
    assert payload["official_handle"] == "test_handle"
    assert payload["events"][0]["source_handle"] == "caller"


@pytest.mark.asyncio
async def test_social_refresh_requires_backend_api_key():
    with pytest.raises(ValueError, match="BACKEND_API_KEY"):
        await refresh_x_for_mint_authenticated(
            backend_frontend_url="http://frontend:3000",
            mint_address="11111111111111111111111111111111",
            backend_api_key="",
        )
