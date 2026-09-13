from sqladmin import ModelView

from app.models.twitter_crawler_settings import TwitterCrawlerSettings


class TwitterCrawlerSettingsAdmin(ModelView, model=TwitterCrawlerSettings):
    name = "Crawler settings"
    name_plural = "Crawler settings"
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
        "updated_at",
    ]
    form_columns = [
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
    ]
    column_labels = {
        "enabled": "Crawler enabled",
        "query_limit": "X search results / query",
        "process_limit": "Candidates / cycle",
        "batch_size": "Claim batch size",
        "max_depth": "Network depth",
        "min_relevance": "Minimum relevance",
        "network_mode": "Network expansion",
        "network_limit": "Network accounts / candidate",
        "lease_seconds": "Worker lease, seconds",
        "rescore_limit": "Candidates rescored / cycle",
        "updated_at": "Updated",
    }
    form_choices = {
        "network_mode": [
            ("none", "None"),
            ("following", "Following"),
            ("followers", "Followers"),
            ("both", "Both"),
        ]
    }
    can_create = False
    can_edit = True
    can_delete = False
    can_view_details = True
