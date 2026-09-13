from sqladmin import ModelView

from app.models.twitter_crawler_run import TwitterCrawlerRun
from app.models.twitter_discovery_scoring import TwitterDiscoveryScore
from app.models.twitter_intelligence import (
    TwitterAccount,
    TwitterAccountScore,
    TwitterAccountSnapshot,
    TwitterAccountTokenStat,
    TwitterDiscoveryCandidate,
    TwitterDiscoveryEvidence,
    TwitterPost,
)


TWITTER_ADMIN_CATEGORY = "Twitter / X monitoring"
PAGE_SIZES = [25, 50, 100, 200]


class TwitterCrawlerRunAdmin(ModelView, model=TwitterCrawlerRun):
    name = "Crawler run"
    name_plural = "Crawler runs / status"
    icon = "fa-solid fa-heart-pulse"
    category = TWITTER_ADMIN_CATEGORY
    column_list = [
        "id",
        "job_name",
        "status",
        "phase",
        "worker",
        "started_at",
        "heartbeat_at",
        "finished_at",
        "duration_ms",
        "error",
    ]
    column_searchable_list = ["job_name", "status", "phase", "worker", "error"]
    column_sortable_list = [
        "id",
        "job_name",
        "status",
        "phase",
        "started_at",
        "heartbeat_at",
        "finished_at",
        "duration_ms",
    ]
    column_default_sort = ("started_at", True)
    column_labels = {
        "job_name": "Job",
        "heartbeat_at": "Last heartbeat",
        "duration_ms": "Duration, ms",
        "error": "Last error",
    }
    page_size = 50
    page_size_options = PAGE_SIZES
    can_create = False
    can_edit = False
    can_delete = False
    can_view_details = True


class TwitterDiscoveryCandidateAdmin(ModelView, model=TwitterDiscoveryCandidate):
    name = "Crawler candidate"
    name_plural = "Crawler queue / health"
    icon = "fa-solid fa-list-check"
    category = TWITTER_ADMIN_CATEGORY
    column_list = [
        "id",
        "username",
        "twitter_id",
        "status",
        "priority",
        "depth",
        "relevance_hint",
        "account_id",
        "attempts",
        "lease_owner",
        "lease_expires_at",
        "last_attempt_at",
        "next_attempt_at",
        "last_error",
        "first_seen_at",
        "last_seen_at",
    ]
    column_searchable_list = [
        "candidate_key",
        "twitter_id",
        "username",
        "display_name",
        "status",
        "lease_owner",
        "last_error",
    ]
    column_sortable_list = [
        "id",
        "username",
        "status",
        "priority",
        "depth",
        "relevance_hint",
        "attempts",
        "lease_expires_at",
        "last_attempt_at",
        "next_attempt_at",
        "first_seen_at",
        "last_seen_at",
    ]
    column_default_sort = ("last_seen_at", True)
    column_labels = {
        "twitter_id": "X user ID",
        "username": "Handle",
        "relevance_hint": "Relevance",
        "account_id": "Registry account",
        "lease_owner": "Worker",
        "lease_expires_at": "Lease until",
        "last_attempt_at": "Last attempt",
        "next_attempt_at": "Next attempt",
        "last_error": "Last error",
        "first_seen_at": "Discovered",
        "last_seen_at": "Last observed",
    }
    form_columns = [
        "account_type_hint",
        "status",
        "priority",
        "relevance_hint",
        "next_attempt_at",
    ]
    page_size = 50
    page_size_options = PAGE_SIZES
    can_create = False
    can_edit = True
    can_delete = False
    can_view_details = True


class TwitterAccountAdmin(ModelView, model=TwitterAccount):
    name = "X account"
    name_plural = "X accounts"
    icon = "fa-solid fa-at"
    category = TWITTER_ADMIN_CATEGORY
    column_list = [
        "id",
        "twitter_id",
        "username",
        "display_name",
        "account_type",
        "status",
        "followers_count",
        "following_count",
        "tweet_count",
        "verified",
        "source",
        "first_seen_at",
        "last_seen_at",
        "last_profile_sync_at",
    ]
    column_searchable_list = ["twitter_id", "username", "display_name", "bio", "source"]
    column_sortable_list = [
        "id",
        "username",
        "followers_count",
        "tweet_count",
        "account_type",
        "status",
        "first_seen_at",
        "last_seen_at",
        "last_profile_sync_at",
    ]
    column_default_sort = ("last_seen_at", True)
    column_labels = {
        "twitter_id": "X user ID",
        "username": "Handle",
        "display_name": "Display name",
        "account_type": "Type",
        "followers_count": "Followers",
        "following_count": "Following",
        "tweet_count": "Posts",
        "first_seen_at": "First seen",
        "last_seen_at": "Last seen",
        "last_profile_sync_at": "Profile sync",
    }
    form_columns = ["account_type", "status"]
    page_size = 50
    page_size_options = PAGE_SIZES
    can_create = False
    can_edit = True
    can_delete = False
    can_view_details = True


class TwitterDiscoveryEvidenceAdmin(ModelView, model=TwitterDiscoveryEvidence):
    name = "Discovery evidence"
    name_plural = "Discovery evidence"
    icon = "fa-solid fa-link"
    category = TWITTER_ADMIN_CATEGORY
    column_list = [
        "id",
        "candidate_id",
        "source_type",
        "discovery_reason",
        "source_ref",
        "query",
        "source_url",
        "observed_at",
    ]
    column_searchable_list = [
        "source_type",
        "discovery_reason",
        "source_ref",
        "query",
        "source_url",
    ]
    column_sortable_list = ["id", "candidate_id", "source_type", "observed_at"]
    column_default_sort = ("observed_at", True)
    page_size = 50
    page_size_options = PAGE_SIZES
    can_create = False
    can_edit = False
    can_delete = False
    can_view_details = True


class TwitterDiscoveryScoreAdmin(ModelView, model=TwitterDiscoveryScore):
    name = "Discovery score"
    name_plural = "Discovery scores"
    icon = "fa-solid fa-ranking-star"
    category = TWITTER_ADMIN_CATEGORY
    column_list = [
        "candidate_id",
        "discovery_score",
        "confidence",
        "relevance_score",
        "source_score",
        "graph_score",
        "engagement_score",
        "early_signal_score",
        "recency_score",
        "evidence_count",
        "source_type_count",
        "score_version",
        "scored_at",
    ]
    column_sortable_list = [
        "candidate_id",
        "discovery_score",
        "confidence",
        "relevance_score",
        "source_score",
        "graph_score",
        "engagement_score",
        "early_signal_score",
        "recency_score",
        "evidence_count",
        "scored_at",
    ]
    column_default_sort = ("discovery_score", True)
    page_size = 50
    page_size_options = PAGE_SIZES
    can_create = False
    can_edit = False
    can_delete = False
    can_view_details = True


class TwitterPostAdmin(ModelView, model=TwitterPost):
    name = "X post"
    name_plural = "X posts"
    icon = "fa-regular fa-message"
    category = TWITTER_ADMIN_CATEGORY
    column_list = [
        "id",
        "twitter_post_id",
        "account_id",
        "text",
        "published_at",
        "likes",
        "replies",
        "reposts",
        "quotes",
        "views",
        "language",
        "sentiment",
        "crypto_relevance",
        "spam_probability",
        "source",
        "created_at",
    ]
    column_searchable_list = ["twitter_post_id", "text", "language", "source"]
    column_sortable_list = [
        "id",
        "account_id",
        "published_at",
        "likes",
        "replies",
        "reposts",
        "quotes",
        "views",
        "sentiment",
        "crypto_relevance",
        "spam_probability",
        "created_at",
    ]
    column_default_sort = ("published_at", True)
    page_size = 50
    page_size_options = PAGE_SIZES
    can_create = False
    can_edit = False
    can_delete = False
    can_view_details = True


class TwitterAccountSnapshotAdmin(ModelView, model=TwitterAccountSnapshot):
    name = "Account snapshot"
    name_plural = "Account growth snapshots"
    icon = "fa-solid fa-chart-line"
    category = TWITTER_ADMIN_CATEGORY
    column_list = [
        "id",
        "account_id",
        "followers_count",
        "following_count",
        "tweet_count",
        "verified",
        "captured_at",
        "source",
    ]
    column_searchable_list = ["source"]
    column_sortable_list = [
        "id",
        "account_id",
        "followers_count",
        "following_count",
        "tweet_count",
        "captured_at",
    ]
    column_default_sort = ("captured_at", True)
    page_size = 50
    page_size_options = PAGE_SIZES
    can_create = False
    can_edit = False
    can_delete = False
    can_view_details = True


class TwitterAccountScoreAdmin(ModelView, model=TwitterAccountScore):
    name = "Account score"
    name_plural = "Account scores"
    icon = "fa-solid fa-gauge-high"
    category = TWITTER_ADMIN_CATEGORY
    column_list = [
        "account_id",
        "influence_score",
        "trust_score",
        "alpha_score",
        "shill_score",
        "bot_score",
        "crypto_relevance_score",
        "solana_relevance_score",
        "score_confidence",
        "score_source",
        "model_version",
        "updated_at",
    ]
    column_searchable_list = ["score_source", "model_version"]
    column_sortable_list = [
        "account_id",
        "influence_score",
        "trust_score",
        "alpha_score",
        "shill_score",
        "bot_score",
        "crypto_relevance_score",
        "solana_relevance_score",
        "score_confidence",
        "updated_at",
    ]
    column_default_sort = ("alpha_score", True)
    page_size = 50
    page_size_options = PAGE_SIZES
    can_create = False
    can_edit = False
    can_delete = False
    can_view_details = True


class TwitterAccountTokenStatAdmin(ModelView, model=TwitterAccountTokenStat):
    name = "Token signal"
    name_plural = "Account token signals"
    icon = "fa-solid fa-coins"
    category = TWITTER_ADMIN_CATEGORY
    column_list = [
        "id",
        "account_id",
        "mint_address",
        "mentions_count",
        "bullish_mentions",
        "bearish_mentions",
        "neutral_mentions",
        "first_mention_at",
        "last_mention_at",
        "avg_return_1h",
        "avg_return_6h",
        "avg_return_24h",
        "avg_return_7d",
        "successful_calls",
        "failed_calls",
        "token_alpha_score",
        "updated_at",
    ]
    column_searchable_list = ["mint_address"]
    column_sortable_list = [
        "id",
        "account_id",
        "mentions_count",
        "bullish_mentions",
        "bearish_mentions",
        "first_mention_at",
        "last_mention_at",
        "avg_return_1h",
        "avg_return_6h",
        "avg_return_24h",
        "avg_return_7d",
        "successful_calls",
        "failed_calls",
        "token_alpha_score",
        "updated_at",
    ]
    column_default_sort = ("updated_at", True)
    page_size = 50
    page_size_options = PAGE_SIZES
    can_create = False
    can_edit = False
    can_delete = False
    can_view_details = True


TWITTER_ADMIN_VIEWS = (
    TwitterCrawlerRunAdmin,
    TwitterDiscoveryCandidateAdmin,
    TwitterAccountAdmin,
    TwitterDiscoveryEvidenceAdmin,
    TwitterDiscoveryScoreAdmin,
    TwitterPostAdmin,
    TwitterAccountSnapshotAdmin,
    TwitterAccountScoreAdmin,
    TwitterAccountTokenStatAdmin,
)
