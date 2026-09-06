from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_subscriber, get_current_superuser
from app.db.session import get_db
from app.schemas.analytics import (
    CollectorRunResponse,
    InsiderClusterResponse,
    JobStatusResponse,
    TokenAnalysisResponse,
    TokenListResponse,
    WalletActivityResponse,
    WalletTopResponse,
)
from app.services.analytics_queries import get_wallet_activity, list_tokens
from app.services.collection import run_full_collection
from app.services.etl import (
    get_insider_clusters,
    get_or_create_jobs,
    get_token_analysis,
    get_top_wallets,
    list_jobs,
)

router = APIRouter()


@router.get("/tokens", response_model=TokenListResponse)
async def read_tokens(
    session: AsyncSession = Depends(get_db),
    sort_by: str = Query(default="ath"),
    order: str = Query(default="desc"),
    limit: int = Query(default=50, ge=1, le=250),
    offset: int = Query(default=0, ge=0),
    current_user=Depends(get_current_subscriber),
) -> TokenListResponse:
    del current_user
    items, total = await list_tokens(
        session,
        limit=limit,
        offset=offset,
        sort_by=sort_by,
        order=order,
    )
    return TokenListResponse(
        items=items,
        meta={"limit": limit, "offset": offset, "total": total},
    )


@router.get("/tokens/{mint_address}/analysis", response_model=TokenAnalysisResponse)
async def read_token_analysis(
    mint_address: str,
    session: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_subscriber),
) -> TokenAnalysisResponse:
    del current_user
    try:
        data = await get_token_analysis(session, mint_address)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    return TokenAnalysisResponse(**data)


@router.get("/wallets/top", response_model=WalletTopResponse)
async def read_top_wallets(
    session: AsyncSession = Depends(get_db),
    by: str = Query(default="profit"),
    period: str = Query(default="all_time"),
    limit: int = Query(default=50, ge=1, le=250),
    offset: int = Query(default=0, ge=0),
    current_user=Depends(get_current_subscriber),
) -> WalletTopResponse:
    del current_user
    if by != "profit" or period != "all_time":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only by=profit&period=all_time is supported for now",
        )
    items, total = await get_top_wallets(session, limit=limit, offset=offset)
    return WalletTopResponse(
        items=items,
        meta={"limit": limit, "offset": offset, "total": total},
    )


@router.get("/wallets/{wallet_address}/activity", response_model=WalletActivityResponse)
async def read_wallet_activity(
    wallet_address: str,
    limit: int = Query(default=100, ge=1, le=250),
    offset: int = Query(default=0, ge=0),
    session: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_subscriber),
) -> WalletActivityResponse:
    del current_user
    try:
        data = await get_wallet_activity(
            session,
            wallet_address,
            limit=limit,
            offset=offset,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    return WalletActivityResponse(**data)


@router.get("/insider/clusters", response_model=InsiderClusterResponse)
async def read_insider_clusters(
    session: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_subscriber),
) -> InsiderClusterResponse:
    del current_user
    items = await get_insider_clusters(session)
    return InsiderClusterResponse(items=items)


@router.get("/collector/jobs", response_model=JobStatusResponse)
async def read_collector_jobs(
    session: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_subscriber),
) -> JobStatusResponse:
    del current_user
    jobs = await list_jobs(session)
    return JobStatusResponse(jobs=jobs)


@router.post("/collector/run", response_model=CollectorRunResponse)
async def run_collector(
    session: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_superuser),
) -> CollectorRunResponse:
    del current_user
    result = await run_full_collection(session)
    await get_or_create_jobs(session)
    return CollectorRunResponse(
        detail="collection queued",
        tasks=[
            f"tokens={result['tokens']}",
            f"metrics={result['metrics']}",
            f"links={result['links']}",
        ],
    )
