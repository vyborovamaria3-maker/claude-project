from app.tasks.celery_app import celery_app


@celery_app.task(name="app.tasks.notifications.send_demo_notification")
def send_demo_notification(email: str, message: str) -> dict[str, str]:
    return {
        "email": email,
        "message": message,
        "status": "queued-demo-notification",
    }
