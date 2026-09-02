from decimal import Decimal

import pytest
from pydantic import ValidationError

from app.schemas.subscription import SubscriptionSettingsUpdate


def test_subscription_settings_update_accepts_admin_values():
    value = SubscriptionSettingsUpdate(
        monthly_price_sol="0.125000001",
        monthly_price_usdt="4.250001",
        free_demo_enabled=True,
        demo_days=14,
        solana_recipient_wallet=" 11111111111111111111111111111111 ",
    )

    assert value.monthly_price_sol == Decimal("0.125000001")
    assert value.monthly_price_usdt == Decimal("4.250001")
    assert value.free_demo_enabled is True
    assert value.demo_days == 14
    assert value.solana_recipient_wallet == "11111111111111111111111111111111"


@pytest.mark.parametrize(
    ("field", "bad_value"),
    [
        ("monthly_price_sol", "-0.1"),
        ("monthly_price_usdt", "-1"),
        ("demo_days", 0),
        ("demo_days", 3651),
    ],
)
def test_subscription_settings_update_rejects_invalid_ranges(field, bad_value):
    payload = {
        "monthly_price_sol": "0",
        "monthly_price_usdt": "0",
        "free_demo_enabled": False,
        "demo_days": 30,
        "solana_recipient_wallet": "",
    }
    payload[field] = bad_value

    with pytest.raises(ValidationError):
        SubscriptionSettingsUpdate(**payload)
