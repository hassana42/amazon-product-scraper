import asyncio
import hashlib
import json
import logging
import os
import secrets
from contextlib import asynccontextmanager
from itertools import islice
from pathlib import Path
from typing import Annotated, Literal

import chromadb
import httpx
from chromadb.errors import ChromaError
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.security import APIKeyHeader

from backend.embeddings import MODEL, Embed, gemini_embedder
from backend.indexing import batch_worker, stored_product, upsert
from backend.models import (
    ASIN,
    DEFAULT_MARKETPLACE,
    MARKETPLACES,
    Batch,
    BatchStatus,
    CatalogStatus,
    Match,
    Product,
    Search,
    Text,
)
from backend.relevance import demo_record, evidence, related, tokens
from backend.storage import Storage, demo_embed

log = logging.getLogger("uvicorn.error")
Source = Literal["catalog", "demo", "all"]


def accepts_source(product: Product, source: Source) -> bool:
    return source == "all" or demo_record(product) == (source == "demo")


def create_app(
    *,
    api_key: str | None = None,
    chroma_path: str | Path | None = None,
    embed: Embed | None = None,
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        key = api_key if api_key is not None else os.environ.get("SCRAPER_API_KEY", "")
        gemini_key = os.environ.get("GEMINI_API_KEY", "")
        mode = os.getenv("EMBEDDING_MODE", "gemini")
        if mode not in {"gemini", "demo"}:
            raise RuntimeError("EMBEDDING_MODE must be gemini or demo.")
        if not key.strip():
            raise RuntimeError("Set SCRAPER_API_KEY.")
        if mode == "gemini" and embed is None and not gemini_key.strip():
            log.warning("Gemini key is missing. Using the local catalog and lexical ranking.")
            mode = "demo"
        namespace = "test" if embed is not None else ("demo-v1" if mode == "demo" else MODEL)
        version = hashlib.sha256(f"{namespace}:768:schema2".encode()).hexdigest()[:12]
        path = Path(chroma_path or os.getenv("CHROMA_PATH", "./data/chroma"))
        path.mkdir(parents=True, exist_ok=True)
        database = chromadb.PersistentClient(path=str(path))
        app.state.storage = Storage(path / f"catalog-state-{version}.sqlite3")
        app.state.products = database.get_or_create_collection(
            f"products-{version}",
            embedding_function=None,
            configuration={"hnsw": {"space": "cosine"}},
        )
        app.state.api_key = key.encode()
        app.state.mode = mode
        app.state.wake = asyncio.Event()
        stop = asyncio.Event()
        with httpx.Client(
            base_url="https://generativelanguage.googleapis.com",
            headers={"x-goog-api-key": gemini_key},
            timeout=45,
        ) as client:
            provider = embed or (demo_embed if mode == "demo" else gemini_embedder(client, MODEL))
            app.state.embed = app.state.storage.embeddings(version, provider)
            worker = asyncio.create_task(batch_worker(app, app.state.wake, stop))
            try:
                yield
            finally:
                stop.set()
                app.state.wake.set()
                await worker

    app = FastAPI(title="Amazon Product Scraper", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[origin.strip() for origin in os.getenv("CORS_ORIGINS", "").split(",") if origin.strip()],
        allow_origin_regex=r"chrome-extension://[a-p]{32}",
        allow_methods=["GET", "POST"],
        allow_headers=["X-API-Key", "Content-Type"],
    )

    @app.exception_handler(ChromaError)
    async def unavailable_catalog(_request: Request, error: ChromaError):
        log.error(json.dumps({"event": "catalog_unavailable", "error_type": type(error).__name__}))
        return JSONResponse(status_code=503, content={"detail": "Catalog storage is unavailable. Try again shortly."})

    header = APIKeyHeader(name="X-API-Key", auto_error=False)

    def authorize(request: Request, key: Annotated[str | None, Depends(header)]) -> None:
        if not key or not secrets.compare_digest(key.encode(), request.app.state.api_key):
            raise HTTPException(401, "Missing or invalid API key")

    secured = [Depends(authorize)]

    def validate_marketplace(marketplace: str) -> None:
        if marketplace not in MARKETPLACES:
            raise HTTPException(422, "Unsupported marketplace")

    def filter_marketplace(marketplace: str | None) -> str | None:
        if marketplace in (None, "all"):
            return None
        validate_marketplace(marketplace)
        return marketplace

    def validate_batch(batch: Batch) -> None:
        for product in batch.products:
            validate_marketplace(product.marketplace)

    def lookup_product(request: Request, marketplace: str, asin: str) -> Product:
        validate_marketplace(marketplace)
        result = request.app.state.products.get(ids=[f"{marketplace}:{asin}"], include=["metadatas"])
        if not result["ids"]:
            raise HTTPException(404, "Product was not found")
        return stored_product(result["metadatas"][0])

    def records(request: Request, market: str | None, scope: Source):
        collection = request.app.state.products
        for offset in range(0, collection.count(), 200):
            page = collection.get(
                where={"marketplace": market} if market else None,
                limit=200,
                offset=offset,
                include=["metadatas"],
            )
            for metadata in page["metadatas"]:
                product = stored_product(metadata)
                if accepts_source(product, scope):
                    yield product
            if len(page["ids"]) < 200:
                break

    def ranked_matches(
        request: Request,
        query: str,
        limit: int,
        market: str | None,
        scope: Source,
        source: Product | None = None,
    ) -> list[Match]:
        terms = tokens(query)
        candidates = []
        for product in records(request, market, scope):
            if source and source.key == product.key:
                continue
            match = related(source, product) if source else evidence(terms, product)
            if match.relevant:
                candidates.append((product, match))
        if not candidates:
            return []

        if request.app.state.mode == "gemini":
            collection = request.app.state.products
            if source:
                value = collection.get(ids=[source.key], include=["embeddings"])["embeddings"][0]
                vector = value.tolist()
            else:
                vector = request.app.state.embed([query], "RETRIEVAL_QUERY")[0]
            response = collection.query(
                query_embeddings=[vector],
                ids=[product.key for product, _ in candidates],
                n_results=min(len(candidates), limit),
                include=["distances"],
            )
            by_id = {product.key: (product, match) for product, match in candidates}
            ranked = [
                (*by_id[identifier], distance)
                for identifier, distance in zip(response["ids"][0], response["distances"][0], strict=True)
                if distance < 1.0  # Positive cosine is required in addition to listing evidence.
            ]
        else:
            candidates.sort(key=lambda entry: (-entry[1].identity_matches, entry[0].title.casefold()))
            ranked = [(product, match, None) for product, match in candidates[:limit]]
        return [
            Match(
                product=product,
                url=product.url,
                distance=distance,
                ranking="gemini" if distance is not None else "lexical",
                reasons=[product.title, product.description[:240]] if product.description else [product.title],
                matched_features=match.matched[:8],
            )
            for product, match, distance in ranked
        ]

    @app.get("/health")
    def health(request: Request):
        request.app.state.products.count()
        return {"status": "ok"}

    @app.get("/v1/status", dependencies=secured, response_model=CatalogStatus)
    def connection_status(request: Request):
        return {
            "mode": request.app.state.mode,
            "products": request.app.state.products.count(),
            "recent": request.app.state.storage.recent(),
        }

    @app.post("/v1/products", dependencies=secured)
    def ingest(batch: Batch, request: Request):
        validate_batch(batch)
        return {"upserted": upsert(request.app, batch)}

    @app.post("/v1/batches", dependencies=secured, response_model=BatchStatus, status_code=202)
    async def submit(batch: Batch, request: Request):
        validate_batch(batch)
        storage = request.app.state.storage
        identifier = await asyncio.to_thread(storage.submit, batch.model_dump_json())
        status = await asyncio.to_thread(storage.status, identifier)
        request.app.state.wake.set()
        log.info(json.dumps({"event": "batch_submitted", "batch_id": identifier, "size": len(batch.products)}))
        return status

    @app.get("/v1/batches/{identifier}", dependencies=secured, response_model=BatchStatus)
    def batch_status(identifier: str, request: Request):
        status = request.app.state.storage.status(identifier)
        if status is None:
            raise HTTPException(404, "Batch was not found")
        return status

    @app.get("/v1/products", dependencies=secured, response_model=list[Product])
    def keyword_search(
        request: Request,
        q: Annotated[Text | None, Query()] = None,
        marketplace: str = DEFAULT_MARKETPLACE,
        limit: Annotated[int, Query(ge=1, le=100)] = 20,
        offset: Annotated[int, Query(ge=0)] = 0,
        source: Source = "catalog",
    ):
        selected = filter_marketplace(marketplace)
        terms = tokens(q) if q is not None else None
        items = records(request, selected, source)
        if terms is not None:
            items = (item for item in items if evidence(terms, item).relevant)
        return list(islice(items, offset, offset + limit))

    @app.get("/v1/products/{marketplace}/{asin}", dependencies=secured, response_model=Product)
    def get_product(marketplace: str, asin: ASIN, request: Request):
        return lookup_product(request, marketplace, asin)

    @app.get("/v1/products/{marketplace}/{asin}/similar", dependencies=secured, response_model=list[Match])
    def similar(
        marketplace: str,
        asin: ASIN,
        request: Request,
        limit: Annotated[int, Query(ge=1, le=20)] = 8,
        market: str = DEFAULT_MARKETPLACE,
        source: Source = "catalog",
    ):
        product = lookup_product(request, marketplace, asin)
        return ranked_matches(request, "", limit, filter_marketplace(market), source, product)

    @app.post("/v1/recommendations", dependencies=secured, response_model=list[Match])
    def recommend(search: Search, request: Request):
        return ranked_matches(
            request, search.query, search.limit, filter_marketplace(search.marketplace), search.source
        )

    return app


app = create_app()
