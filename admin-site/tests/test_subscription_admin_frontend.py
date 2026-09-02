from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "app" / "static"


def test_subscription_page_is_linked_from_main_admin():
    html = (STATIC / "index.html").read_text(encoding="utf-8")

    assert 'id="subscriptionNav"' in html
    assert "Подписка / Mini App" in html
    assert '/static/subscription-ui.js' in html
    assert '/static/subscription-ui.css' in html


def test_subscription_browser_code_uses_main_admin_api_only():
    script = (STATIC / "subscription-ui.js").read_text(encoding="utf-8")

    assert '"/api/subscription-settings"' in script
    assert "X-API-Key" not in script
    assert "POTAPOFF_BACKEND_API_KEY" not in script
    assert "POTAPOFF_SUBSCRIPTION_ADMIN_KEY" not in script
    assert "BACKEND_API_KEY" not in script
    assert "SUBSCRIPTION_INTERNAL_KEY" not in script
    assert "SUBSCRIPTION_ADMIN_KEY" not in script


def test_subscription_proxy_is_mounted_in_main_admin():
    main_admin = (ROOT / "app" / "main_admin.py").read_text(encoding="utf-8")
    proxy = (ROOT / "app" / "subscription_admin.py").read_text(encoding="utf-8")

    assert "build_subscription_admin_router" in main_admin
    assert "app.include_router(build_subscription_admin_router())" in main_admin
    assert 'prefix="/api/subscription-settings"' in proxy
    assert 'headers={"X-API-Key": api_key}' in proxy
    assert "POTAPOFF_SUBSCRIPTION_ADMIN_KEY" in proxy
    assert "POTAPOFF_SUBSCRIPTION_API_KEY" not in proxy
    assert "POTAPOFF_BACKEND_API_KEY" not in proxy
    assert "BACKEND_API_KEY" not in proxy
    assert "Depends(require_admin)" in proxy
