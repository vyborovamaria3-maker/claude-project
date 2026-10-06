from fastapi import FastAPI, Depends, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from typing import List, Optional
from pydantic import BaseModel, Field
import uuid

from app.db.session import get_db
from app.models.user import User
from app.models.x_account import XAccount
from app.models.campaign import Campaign
from app.models.proxy import Proxy
from app.models.lore import Lore, LoreExample
from app.models.alert import Alert
from app.services.auth import get_current_user
from app.services.accounts import create_x_account, get_accounts, remove_account
from app.services.campaigns import create_campaign, get_campaigns, update_campaign
from app.services.proxies import add_proxy, get_proxy_status
from app.services.llm import generate_reply, setup_llm
from app.services.rate_limit import check_rate_limit
from app.services.rabbitmq import send_task
from app.models.alert import create_alert

app = FastAPI(title="AI Reply Guy API")

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# dep
@app.get("/")
async def root():
    return {"message": "AI Reply Guy API", "version": "1.0.0"}

# Accounts
@app.post("/api/accounts")
async def api_create_account(
    request,
    x_username: str,
    cookies: str,
    proxy: Optional[dict] = None,
    db: Session = Depends(get_db)
):
    current_user = get_current_user(request)
    try:
        account = await create_x_account(
            db, 
            user_id=current_user.id,
            x_username=x_username,
            cookies=cookies,
            proxy=proxy
        )
        return {"success": True, "account_id": str(account.id)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/accounts")
async def api_get_accounts(db: Session = Depends(get_db)):
    current_user = get_current_user(request)
    accounts = await get_accounts(db, user_id=current_user.id)
    return accounts

@app.delete("/api/accounts/{account_id}")
async def api_delete_account(account_id: str, db: Session = Depends(get_db)):
    current_user = get_current_user(request)
    await remove_account(db, account_id=account_id, user_id=current_user.id)
    return {"success": True}

# Campaigns
@app.post("/api/campaigns")
async def api_create_campaign(
    request,
    name: str,
    lore_id: str,
    account_id: str,
    campaign_sources: List[dict] = [],
    database_filters: dict = {},
    db: Session = Depends(get_db)
):
    current_user = get_current_user(request)
    campaign = await create_campaign(
        db,
        user_id=current_user.id,
        name=name,
        lore_id=lore_id,
        account_id=account_id,
        campaign_sources=campaign_sources,
        filters=database_filters
    )
    # Start worker via RabbitMQ
    send_task("campaign_start", {"campaign_id": str(campaign.id)})
    return {"success": True, "campaign_id": str(campaign.id)}

@app.get("/api/campaigns")
async def api_get_campaigns(db: Session = Depends(get_db)):
    current_user = get_current_user(request)
    campaigns = await get_campaigns(db, user_id=current_user.id)
    return campaigns

@app.patch("/api/campaigns/{campaign_id}")
async def api_update_campaign(
    campaign_id: str,
    status: str,
    rate_per_hour: int,
    db: Session = Depends(get_db)
):
    campaign = await update_campaign(db, campaign_id=campaign_id, status=status)
    return {"success": True}

# Lore
@app.post("/api/lore")
async def api_create_lore(
    request,
    name: str,
    style: str,
    bio: str,
    system_prompt: Optional[str] = None,
    db: Session = Depends(get_db)
):
    current_user = get_current_user(request)
    lore = await create_lore(
        db,
        user_id=current_user.id,
        name=name,
        style=style,
        bio=bio,
        system_prompt=system_prompt
    ) Beverage
    return {"success": True, "lore_id": str(lore.id)}

@app.get("/api/lore")
async def api_get_lore(db: Session = Depends(get_db)):
    current_user = get_current_user(request)
    loras = await get_lores(db, user_id=current_user.id)
    return loras

@app.post("/api/lore/{lore_id}/examples")
async def api_add_lore_example(
    lore_id: str,
    tweet_text: str,
    reply_text: str,
    db: Session = Depends(get_db)
):
    # Will use pgvector to store embeddings
    example = await create_lore_example(db, lore_id=lore_id, tweet_text=tweet_text, reply_text=reply_text)
    return {"success": True}

# Proxies
@app.post("/api/accounts/{account_id}/proxy")
async def api_add_proxy(
    account_id: str,
    proxy_string: str,
    geo_location: str = "us",
    db: Session = Depends(get_db)
):
    proxy = await add_proxy(db, account_id=account_id, proxy_string=proxy_string, geo_location=geo_location)
    return {"success": True, "proxy_id": str(proxy.id)}

@app.get("/api/accounts/{account_id}/proxy/status")
async def api_get_proxy_status(account_id: str, db: Session = Depends(get_db)):
    status_info = await get_proxy_status(db, account_id=account_id)
    return status_info

# Stats
@app.get("/api/campaigns/{campaign_id}/stats")
async def api_get_campaign_stats(campaign_id: str, db: Session = Depends(get_db)):
    stats = await get_campaign_stats(db, campaign_id=campaign_id)
    return stats

@app.get("/api/accounts/{account_id}/stats")
async def api_get_account_stats(account_id: str, db: Session = Depends(get_db)):
    stats = await get_account_stats(db, account_id=account_id)
    return stats

# Alerts
@app.get("/api/alerts")
async def api_get_alerts(db: Session = Depends(get_db)):
    current_user = get_current_user(request)
    alerts = await get_alerts(db, user_id=current_user.id)
    return alerts

@app.patch("/api/alerts/{alert_id}/read")
async def api_read_alert(alert_id: str, db: Session = Depends(get_db)):
    await mark_alert_as_read(db, alert_id=alert_id)
    return {"success": True}

# System
@app.get("/api/health")
async def health_check():
    return {"status": "healthy", "uptime": uptime}
