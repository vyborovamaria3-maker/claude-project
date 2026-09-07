from app.core.config import Settings
from app.services import market_ingestion


class FakeResponse:
    def __init__(self, payload, status_code):
        self.payload = payload
        self.status_code = status_code
        self.headers = {}

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self):
        return self.payload


async def test_retry_rate_limit_and_latency_metrics_are_recorded(monkeypatch):
    responses = [
        FakeResponse({}, 429),
        FakeResponse({"ok": True}, 200),
    ]

    class FakeClient:
        async def get(self, _url, headers=None):
            del headers
            return responses.pop(0)

    async def no_sleep(_delay):
        return None

    monkeypatch.setattr(market_ingestion.asyncio, "sleep", no_sleep)
    monkeypatch.setattr(market_ingestion.random, "uniform", lambda _a, _b: 0.0)

    request_429 = market_ingestion.PROVIDER_REQUESTS.labels(
        provider="birdeye",
        operation="price",
        result="429",
    )
    request_200 = market_ingestion.PROVIDER_REQUESTS.labels(
        provider="birdeye",
        operation="price",
        result="200",
    )
    retries = market_ingestion.PROVIDER_RETRIES.labels(
        provider="birdeye",
        operation="price",
        reason="429",
    )
    rate_limits = market_ingestion.PROVIDER_RATE_LIMITS.labels(
        provider="birdeye",
        operation="price",
    )
    latency = market_ingestion.PROVIDER_REQUEST_LATENCY.labels(
        provider="birdeye",
        operation="price",
    )

    before_429 = request_429._value.get()
    before_200 = request_200._value.get()
    before_retries = retries._value.get()
    before_rate_limits = rate_limits._value.get()
    def latency_count():
        return next(
            sample.value
            for metric in latency.collect()
            for sample in metric.samples
            if sample.name.endswith("_count")
        )

    before_latency_count = latency_count()

    settings = Settings(
        secret_key="o" * 64,
        environment="test",
        birdeye_max_retries=1,
        birdeye_backoff_base_seconds=0.01,
        birdeye_backoff_max_seconds=0.1,
    )
    result = await market_ingestion._request_json(
        FakeClient(),
        "https://birdeye.invalid/price",
        retry_settings=settings,
        provider="birdeye",
        operation="price",
    )

    assert result == {"ok": True}
    assert request_429._value.get() - before_429 == 1
    assert request_200._value.get() - before_200 == 1
    assert retries._value.get() - before_retries == 1
    assert rate_limits._value.get() - before_rate_limits == 1
    assert latency_count() - before_latency_count == 2
