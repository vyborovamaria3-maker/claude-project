from fastapi import APIRouter, Depends
from pydantic import BaseModel, EmailStr, Field

from app.api.deps import get_current_superuser
from app.tasks.notifications import send_demo_notification

router = APIRouter()


class DemoNotificationRequest(BaseModel):
    email: EmailStr
    message: str = Field(min_length=1, max_length=500)


class DemoNotificationResponse(BaseModel):
    task_id: str
    detail: str


@router.post("/demo-notification", response_model=DemoNotificationResponse)
def queue_demo_notification(
    payload: DemoNotificationRequest,
    current_user=Depends(get_current_superuser),
) -> DemoNotificationResponse:
    del current_user
    result = send_demo_notification.delay(payload.email, payload.message)
    return DemoNotificationResponse(task_id=result.id, detail="queued")
