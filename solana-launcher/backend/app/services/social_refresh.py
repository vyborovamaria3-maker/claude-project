from __future__ import annotations

import httpx


async def refresh_x_for_mint_authenticated(
    *,
    backend_frontend_url: str,
    mint_address: str,
    backend_api_key: str,
) -> dict:
    if not backend_api_key:
        raise ValueError("BACKEND_API_KEY is not configured")

    url = f"{backend_frontend_url.rstrip('/')}/api/trade/dev-twitter"
    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.get(
            url,
            params={"mint": mint_address, "strategy": "auto"},
            headers={"X-Backend-API-Key": backend_api_key},
        )
        response.raise_for_status()
        stats = response.json()

    tweets = stats.get("topTweets") or []
    events = [
        {
            "source_handle": item.get("author") or "x",
            "source_name": item.get("author") or "X",
            "source_url": (
                f"https://x.com/{item.get('author')}"
                if item.get("author")
                else None
            ),
            "text": item.get("text") or "",
            "occurred_at": item.get("timestamp"),
            "metrics": {
                "likes": item.get("likes", 0),
                "retweets": item.get("retweets", 0),
                "views": item.get("views", 0),
                "suspicious": item.get("isSuspicious", False),
            },
        }
        for item in tweets
        if item.get("text")
    ]
    return {
        "token_mint": mint_address,
        "token_symbol": stats.get("symbol"),
        "official_handle": stats.get("twitterHandle"),
        "events": events,
    }
