from fastapi import APIRouter, Depends

from app.api.deps import get_current_subscriber, get_current_user
from app.schemas.user import UserRead

router = APIRouter()


@router.get("/me", response_model=UserRead)
async def read_current_user(current_user=Depends(get_current_user)) -> UserRead:
    return UserRead.model_validate(current_user)


@router.get("/access")
async def read_current_subscriber(current_user=Depends(get_current_subscriber)) -> dict[str, bool]:
    """Lightweight paid-access probe used by server-side route authorization."""
    return {"active": True}
