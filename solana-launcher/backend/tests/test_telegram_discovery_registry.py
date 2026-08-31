from app.services.telegram_discovery_registry import _next_delay


def test_registry_refreshes_strong_channels_more_often() -> None:
    strong = _next_delay(
        state="validated",
        relevance_score=80,
        failure_count=0,
        strong_seconds=600,
        normal_seconds=1800,
        rejected_seconds=21600,
        unavailable_seconds=3600,
    )
    normal = _next_delay(
        state="validated",
        relevance_score=45,
        failure_count=0,
        strong_seconds=600,
        normal_seconds=1800,
        rejected_seconds=21600,
        unavailable_seconds=3600,
    )
    rejected = _next_delay(
        state="rejected",
        relevance_score=10,
        failure_count=0,
        strong_seconds=600,
        normal_seconds=1800,
        rejected_seconds=21600,
        unavailable_seconds=3600,
    )

    assert strong == 600
    assert normal == 1800
    assert rejected == 21600


def test_unavailable_registry_uses_bounded_exponential_backoff() -> None:
    first = _next_delay(
        state="unavailable",
        relevance_score=0,
        failure_count=1,
        strong_seconds=600,
        normal_seconds=1800,
        rejected_seconds=21600,
        unavailable_seconds=3600,
    )
    fourth = _next_delay(
        state="unavailable",
        relevance_score=0,
        failure_count=4,
        strong_seconds=600,
        normal_seconds=1800,
        rejected_seconds=21600,
        unavailable_seconds=3600,
    )
    huge = _next_delay(
        state="unavailable",
        relevance_score=0,
        failure_count=50,
        strong_seconds=600,
        normal_seconds=1800,
        rejected_seconds=21600,
        unavailable_seconds=3600,
    )

    assert first == 3600
    assert fourth == 28800
    assert huge <= 7 * 86400
