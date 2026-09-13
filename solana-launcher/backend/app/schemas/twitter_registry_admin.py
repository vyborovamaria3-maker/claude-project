from __future__ import annotations

from pydantic import AnyHttpUrl, BaseModel, ConfigDict, Field, StrictBool


class TwitterDiscoveryConfigPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    discovery_enabled: StrictBool | None = None
    dexscreener_enabled: StrictBool | None = None
    coinmarketcap_enabled: StrictBool | None = None
    seed_discovery_enabled: StrictBool | None = None
    public_web_enabled: StrictBool | None = None
    x_api_enrichment_enabled: StrictBool | None = None
    cmc_limit: int | None = Field(default=None, ge=1, le=5000, strict=True)
    rescore_limit: int | None = Field(default=None, ge=1, le=5000, strict=True)
    process_limit: int | None = Field(default=None, ge=1, le=5000, strict=True)
    network_limit: int | None = Field(default=None, ge=1, le=1000, strict=True)
    max_depth: int | None = Field(default=None, ge=0, le=8, strict=True)
    min_relevance: float | None = Field(
        default=None,
        ge=0.0,
        le=100.0,
        allow_inf_nan=False,
        strict=True,
    )
    batch_size: int | None = Field(default=None, ge=1, le=500, strict=True)


class TwitterDiscoveryRunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    trigger: str = Field(
        default="admin_manual",
        min_length=1,
        max_length=32,
        pattern=r"^[a-zA-Z0-9_.:-]+$",
    )
    public_urls: list[AnyHttpUrl] = Field(default_factory=list, max_length=20)
