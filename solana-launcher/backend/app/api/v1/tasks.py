from fastapi import APIRouter
from pydantic import BaseModel, EmailStr, Field

from app.tasks.notifications import send_demo_notification

router = APIRouter()


class DemoNotificationRequest(BaseModel):
    email: EmailStr
    message: str = Field(min_length=1, max_length=500)


class DemoNotificationResponse(BaseModel):
    task_id: str
    detail: str


@router.post("/demo-notification", response_model=DemoNotificationResponse)
def queue_demo_notification(payload: DemoNotificationRequest) -> DemoNotificationResponse:
    result = send_demo_notification.delay(payload.email, payload.message)
    return DemoNotificationResponse(task_id=result.id, detail="queued")
