from sqladmin import Admin, ModelView
from sqladmin.authentication import AuthenticationBackend
from starlette.requests import Request

from app.core.config import Settings
from app.models.subscription_order import SubscriptionOrder
from app.models.subscription_settings import SubscriptionSettings
from app.models.user import User


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
    column_searchable_list = ["email", "wallet_address", "telegram_id", "telegram_username", "full_name"]
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
    return admin
