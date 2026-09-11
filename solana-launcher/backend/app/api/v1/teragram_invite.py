from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Literal


from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field


from app.api.deps import get_current_subscriber, get_current_superuser
from app.services.teragram_invite_source import (
    get_teragram_invite_status,
    list_teragram_invite_channels,
)
from app.services.teragram_scan_job import teragram_scan_manager




router = APIRouter()




class TeraGramScanRequest(BaseModel):
    mode: Literal["preview", "full"] = "preview"
    max_chats: int | None = Field(default=None, ge=1, le=10_000_000)
    seed_limit: int = Field(default=250, ge=1, le=5000)
    signal_source: Literal["auto", "content", "entities", "metadata"] = "auto"
    threads: int | None = Field(default=None, ge=1, le=256)
    memory_limit: str = Field(default="4GB", min_length=2, max_length=16)
    fetch_size: int = Field(default=10_000, ge=1, le=1_000_000)




@router.get("/status")
async def teragram_invite_status(
    request: Request,
    current_user=Depends(get_current_subscriber),
) -> dict:
    active_seed_database = str(
        getattr(
            request.app.state.settings,
            "telegram_public_web_seed_database",
            "",
        )
        or ""
    )
    return get_teragram_invite_status(
        active_seed_database=active_seed_database
    )




@router.get("/channels")
async def teragram_invite_channels(
    limit: int = Query(default=250, ge=1, le=5000),
    classification: str | None = Query(default=None),
    current_user=Depends(get_current_subscriber),
) -> dict:
    try:
        items, total = list_teragram_invite_channels(
            limit=limit,
            classification=classification,
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc


    return {
        "items": items,
        "meta": {
            "limit": limit,
            "total": total,
            "classification": classification,
        },
    }


@router.get("/discovery")
def get_teragram_discovery(
    current_user=Depends(get_current_subscriber),
) -> dict:
    graph_path = Path(
        os.getenv(
            "TG_TERAGRAM_GRAPH_PATH",
            "data/teragram_graph/discovery.json",
        )
    ).expanduser()

    if not graph_path.is_absolute():
        graph_path = Path.cwd() / graph_path

    if not graph_path.is_file():
        return {
            "status": "not_ready",
            "candidate_count": 0,
            "candidates": [],
        }

    try:
        payload = json.loads(graph_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to read TeraGram discovery output: {exc}",
        ) from exc

    candidates = payload.get("candidates")
    if not isinstance(candidates, list):
        candidates = []

    return {
        "status": "ready",
        "generated_at": payload.get("generated_at"),
        "root_candidate_count": payload.get("root_candidate_count", 0),
        "candidate_count": len(candidates),
        "candidates": candidates,
    }


@router.get("/verified")
def get_teragram_verified(
    current_user=Depends(get_current_subscriber),
) -> dict:
    verified_path = Path(
        os.getenv(
            "TG_TERAGRAM_VERIFIED_PATH",
            "data/teragram_curated/verified_sources.json",
        )
    ).expanduser()

    if not verified_path.is_absolute():
        verified_path = Path.cwd() / verified_path

    if not verified_path.is_file():
        return {
            "status": "not_ready",
            "total_sources": 0,
            "sources": [],
        }

    try:
        payload = json.loads(verified_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to read TeraGram verified output: {exc}",
        ) from exc

    sources = payload.get("sources")
    if not isinstance(sources, list):
        sources = []

    return {
        "status": "ready",
        "generated_at": payload.get("generated_at"),
        "total_candidates": payload.get("total_candidates", 0),
        "checked": payload.get("checked", 0),
        "alive": payload.get("alive", 0),
        "accepted": payload.get("accepted", 0),
        "rejected": payload.get("rejected", 0),
        "total_sources": len(sources),
        "sources": sources,
    }


@router.post("/scan")
async def start_teragram_scan(
    payload: TeraGramScanRequest,
    current_user=Depends(get_current_superuser),
) -> dict:
    try:
        job = teragram_scan_manager.start(
            mode=payload.mode,
            max_chats=payload.max_chats,
            seed_limit=payload.seed_limit,
            signal_source=payload.signal_source,
            threads=payload.threads,
            memory_limit=payload.memory_limit,
            fetch_size=payload.fetch_size,
        )
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    except RuntimeError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(exc),
        ) from exc


    return {"job": job}




@router.get("/scan/status")
async def teragram_scan_status(
    current_user=Depends(get_current_superuser),
) -> dict:
    return {"job": teragram_scan_manager.status()}




@router.post("/scan/stop")
async def stop_teragram_scan(
    current_user=Depends(get_current_superuser),
) -> dict:
    try:
        job = teragram_scan_manager.stop()
    except RuntimeError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(exc),
        ) from exc


    return {"job": job}
