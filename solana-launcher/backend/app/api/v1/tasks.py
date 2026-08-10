from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, EmailStr, Field

from app.api.deps import get_current_subscriber
from app.core.rate_limit import make_limit_key
from app.models.user import User
from app.tasks.notifications import send_demo_notification

router = APIRouter()


class DemoNotificationRequest(BaseModel):
    email: EmailStr
    message: str = Field(min_length=1, max_length=500)


class DemoNotificationResponse(BaseModel):
    task_id: str
    detail: str


@router.post("/demo-notification", response_model=DemoNotificationResponse)
async def queue_demo_notification(
    request: Request,
    payload: DemoNotificationRequest,
    current_user: User = Depends(get_current_subscriber),
) -> DemoNotificationResponse:
    limiter = request.app.state.rate_limiter
    limit_result = await limiter.allow(
        make_limit_key("task", "demo-notification", str(current_user.id)),
        limit=10,
        window_seconds=60,
    )
    if not limit_result.allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many requests",
            headers={"Retry-After": str(limit_result.retry_after)},
        )

    result = send_demo_notification.delay(payload.email, payload.message)
    return DemoNotificationResponse(task_id=result.id, detail="queued")
