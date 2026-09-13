from sqladmin import Admin, ModelView
from sqladmin.authentication import AuthenticationBackend
from starlette.requests import Request

from app.core.config import Settings
from app.models.subscription_order import SubscriptionOrder
from app.models.subscription_settings import SubscriptionSettings
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
from app.models.user import User


TWITTER_ADMIN_CATEGORY = "Twitter / X monitoring"


class AdminAuth(AuthenticationBackend):
    def __init__(self, settings: Settings) -> None:
        super().__init__(secret_key=settings.admin_session_secret)
        self._settings = settings

    async def login(self, request: Request) -> bool:
        form = await request.form()
        username = form.get("username")
        password = form.get("password")
        if username == self._settings.admin_username and password == self._settings.admin_password:
            request.session["admin_authenticated"] = True
            request.session["admin_username"] = self._settings.admin_username
            return True
        return False

    async def logout(self, request: Request) -> bool:
        request.session.pop("admin_authenticated", None)
        request.session.pop("admin_username", None)
        return True

    async def authenticate(self, request: Request) -> bool:
        return bool(request.session.get("admin_authenticated"))


class UserAdmin(ModelView, model=User):
    name = "User"
    name_plural = "Users"
    column_list = [
        "id",
        "email",
        "wallet_address",
        "telegram_id",
        "telegram_username",
        "is_active",
        "is_superuser",
        "created_at",
    ]
    column_searchable_list = [
        "email",
        "wallet_address",
        "telegram_id",
        "telegram_username",
        "full_name",
    ]
    column_sortable_list = ["id", "email", "created_at"]
    form_excluded_columns = ["hashed_password"]
    can_create = False
    can_edit = False
    can_delete = False


class SubscriptionSettingsAdmin(ModelView, model=SubscriptionSettings):
    name = "Subscription settings"
    name_plural = "Subscription settings"
    icon = "fa-solid fa-credit-card"
    column_list = [
        "monthly_price_sol",
        "monthly_price_usdt",
        "free_demo_enabled",
        "demo_days",
        "solana_recipient_wallet",
        "updated_at",
    ]
    form_columns = [
        "monthly_price_sol",
        "monthly_price_usdt",
        "free_demo_enabled",
        "demo_days",
        "solana_recipient_wallet",
    ]
    column_labels = {
        "monthly_price_sol": "Monthly price, SOL",
        "monthly_price_usdt": "Monthly price, USDT (Solana)",
        "free_demo_enabled": "Free demo enabled",
        "demo_days": "Free demo days",
        "solana_recipient_wallet": "Recipient Solana wallet",
    }
    can_create = False
    can_edit = True
    can_delete = False


class SubscriptionOrderAdmin(ModelView, model=SubscriptionOrder):
    name = "Subscription order"
    name_plural = "Subscription orders"
    icon = "fa-solid fa-receipt"
    column_list = [
        "payload",
        "telegram_user_id",
        "login",
        "currency",
        "total_amount",
        "access_days",
        "status",
        "payment_signature",
        "created_at",
        "paid_at",
    ]
    column_searchable_list = [
        "payload",
        "login",
        "payment_reference",
        "payment_signature",
    ]
    column_sortable_list = ["created_at", "paid_at", "status", "currency"]
    can_create = False
    can_edit = False
    can_delete = False


class TwitterAccountAdmin(ModelView, model=TwitterAccount):
    name = "X account"
    name_plural = "X accounts"
    icon = "fa-brands fa-x-twitter"
    category = TWITTER_ADMIN_CATEGORY
    category_icon = "fa-brands fa-x-twitter"
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
    page_size_options = [25, 50, 100, 200]
    can_create = False
    can_edit = True
    can_delete = False
    can_view_details = True


class TwitterDiscoveryCandidateAdmin(ModelView, model=TwitterDiscoveryCandidate):
    name = "Crawler candidate"
    name_plural = "Crawler queue / health"
    icon = "fa-solid fa-heart-pulse"
    category = TWITTER_ADMIN_CATEGORY
    category_icon = "fa-brands fa-x-twitter"
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
    page_size_options = [25, 50, 100, 200]
    can_create = False
    can_edit = True
    can_delete = False
    can_view_details = True


class TwitterDiscoveryEvidenceAdmin(ModelView, model=TwitterDiscoveryEvidence):
    name = "Discovery evidence"
    name_plural = "Discovery evidence"
    icon = "fa-solid fa-link"
    category = TWITTER_ADMIN_CATEGORY
    category_icon = "fa-brands fa-x-twitter"
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
    page_size_options = [25, 50, 100, 200]
    can_create = False
    can_edit = False
    can_delete = False
    can_view_details = True


class TwitterDiscoveryScoreAdmin(ModelView, model=TwitterDiscoveryScore):
    name = "Discovery score"
    name_plural = "Discovery scores"
    icon = "fa-solid fa-ranking-star"
    category = TWITTER_ADMIN_CATEGORY
    category_icon = "fa-brands fa-x-twitter"
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
    page_size_options = [25, 50, 100, 200]
    can_create = False
    can_edit = False
    can_delete = False
    can_view_details = True


class TwitterPostAdmin(ModelView, model=TwitterPost):
    name = "X post"
    name_plural = "X posts"
    icon = "fa-regular fa-message"
    category = TWITTER_ADMIN_CATEGORY
    category_icon = "fa-brands fa-x-twitter"
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
    page_size_options = [25, 50, 100, 200]
    can_create = False
    can_edit = False
    can_delete = False
    can_view_details = True


class TwitterAccountSnapshotAdmin(ModelView, model=TwitterAccountSnapshot):
    name = "Account snapshot"
    name_plural = "Account growth snapshots"
    icon = "fa-solid fa-chart-line"
    category = TWITTER_ADMIN_CATEGORY
    category_icon = "fa-brands fa-x-twitter"
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
    page_size_options = [25, 50, 100, 200]
    can_create = False
    can_edit = False
    can_delete = False
    can_view_details = True


class TwitterAccountScoreAdmin(ModelView, model=TwitterAccountScore):
    name = "Account score"
    name_plural = "Account scores"
    icon = "fa-solid fa-gauge-high"
    category = TWITTER_ADMIN_CATEGORY
    category_icon = "fa-brands fa-x-twitter"
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
    page_size_options = [25, 50, 100, 200]
    can_create = False
    can_edit = False
    can_delete = False
    can_view_details = True


class TwitterAccountTokenStatAdmin(ModelView, model=TwitterAccountTokenStat):
    name = "Token signal"
    name_plural = "Account token signals"
    icon = "fa-solid fa-coins"
    category = TWITTER_ADMIN_CATEGORY
    category_icon = "fa-brands fa-x-twitter"
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
    page_size_options = [25, 50, 100, 200]
    can_create = False
    can_edit = False
    can_delete = False
    can_view_details = True


TWITTER_ADMIN_VIEWS = (
    TwitterDiscoveryCandidateAdmin,
    TwitterAccountAdmin,
    TwitterDiscoveryEvidenceAdmin,
    TwitterDiscoveryScoreAdmin,
    TwitterPostAdmin,
    TwitterAccountSnapshotAdmin,
    TwitterAccountScoreAdmin,
    TwitterAccountTokenStatAdmin,
)


def setup_admin(app, engine, settings: Settings) -> Admin:
    admin = Admin(
        app,
        engine,
        title=settings.app_name,
        base_url="/admin",
        authentication_backend=AdminAuth(settings),
    )
    admin.add_view(UserAdmin)
    admin.add_view(SubscriptionSettingsAdmin)
    admin.add_view(SubscriptionOrderAdmin)
    for view in TWITTER_ADMIN_VIEWS:
        admin.add_view(view)
    return admin
