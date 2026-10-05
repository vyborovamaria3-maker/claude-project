from sqladmin import ModelView

from app.models.twitter_crawler_settings import TwitterCrawlerSettings


class TwitterCrawlerSettingsAdmin(ModelView, model=TwitterCrawlerSettings):
    name = "Crawler settings (read-only)"
    name_plural = "Crawler settings (read-only)"
    icon = "fa-solid fa-sliders"
    category = "Twitter / X monitoring"
    column_list = [
        "enabled",
        "query_limit",
        "process_limit",
        "batch_size",
        "max_depth",
        "min_relevance",
        "network_mode",
        "network_limit",
        "lease_seconds",
        "rescore_limit",
        "public_enabled",
        "public_dexscreener_latest",
        "public_dexscreener_boosts",
        "public_db_solana_tokens",
        "public_cmc_limit",
        "public_rescore_limit",
        "updated_at",
    ]
    column_labels = {
        "enabled": "X API discovery cycle enabled",
        "query_limit": "X search results / query",
        "process_limit": "Candidates / cycle",
        "batch_size": "Claim batch size",
        "max_depth": "Network depth",
        "min_relevance": "Minimum relevance",
        "network_mode": "Network expansion",
        "network_limit": "Network accounts / candidate",
        "lease_seconds": "Worker lease, seconds",
        "rescore_limit": "Candidates rescored / X cycle",
        "public_enabled": "Public discovery enabled",
        "public_dexscreener_latest": "DEX Screener latest profiles",
        "public_dexscreener_boosts": "DEX Screener latest boosts",
        "public_db_solana_tokens": "DB Solana tokens / public run",
        "public_cmc_limit": "CoinMarketCap listings / public run",
        "public_rescore_limit": "Candidates rescored / public run",
        "updated_at": "Updated",
    }
    can_create = False
    can_edit = False
    can_delete = False
    can_view_details = True
