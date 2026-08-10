from app.schemas.auth import TelegramCallbackResponse


def test_telegram_callback_response_strips_query_and_fragment_from_redirect():
    response = TelegramCallbackResponse(
        access_token="secret-token",
        expires_in=3600,
        redirect_url="https://potapoff.fun/?token=secret-token#dashboard",
    )
    assert response.redirect_url == "https://potapoff.fun/"
    assert "secret-token" not in response.redirect_url
