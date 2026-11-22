import json
from pathlib import Path
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, StringConstraints

MARKETPLACES = json.loads((Path(__file__).resolve().parents[1] / "marketplaces.json").read_text())
DEFAULT_MARKETPLACE = "US"
Text = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]
ASIN = Annotated[str, StringConstraints(pattern=r"^[A-Z0-9]{10}$")]


class Product(BaseModel):
    model_config = ConfigDict(extra="forbid")

    marketplace: str
    asin: ASIN
    title: Text
    brand: Text | None = None
    price: Text | None = None
    rating: Text | None = None
    review_count: Text | None = None
    availability: Text | None = None
    category: Text | None = None
    images: list[HttpUrl] = Field(default_factory=list, max_length=12)
    description: Annotated[str, StringConstraints(strip_whitespace=True, max_length=4000)] = ""

    @property
    def key(self) -> str:
        return f"{self.marketplace}:{self.asin}"

    @property
    def url(self) -> str:
        return f"https://www.{MARKETPLACES[self.marketplace]}/dp/{self.asin}"

    def document(self) -> str:
        return "\n".join(
            part
            for part in (
                self.title,
                self.brand,
                self.category,
                self.price,
                self.description,
            )
            if part
        )


class Batch(BaseModel):
    products: list[Product] = Field(min_length=1, max_length=40)


class BatchStatus(BaseModel):
    id: str
    status: Literal["queued", "processing", "completed", "failed"]
    submitted_at: str
    upserted: int | None
    error: str | None


class Search(BaseModel):
    query: Text
    marketplace: str | None = DEFAULT_MARKETPLACE
    limit: int = Field(default=8, ge=1, le=20)
    source: Literal["catalog", "demo", "all"] = "catalog"


class Match(BaseModel):
    product: Product
    url: str
    distance: float | None = None
    ranking: Literal["lexical", "gemini"] = "gemini"
    reasons: list[str]
    matched_features: list[str] = Field(default_factory=list)


class CatalogStatus(BaseModel):
    mode: Literal["gemini", "demo"]
    products: int
    recent: list[BatchStatus]
