import asyncio
import json
import logging

from fastapi import FastAPI, HTTPException

from backend.models import Batch, Product

log = logging.getLogger("uvicorn.error")


def stored_product(metadata: dict) -> Product:
    return Product.model_validate_json(metadata["product"])


def upsert(app: FastAPI, batch: Batch) -> int:
    products = list({product.key: product for product in batch.products}.values())
    documents = [product.document() for product in products]
    vectors = app.state.embed(documents, "RETRIEVAL_DOCUMENT")
    app.state.products.upsert(
        ids=[product.key for product in products],
        embeddings=vectors,
        documents=[document.lower() for document in documents],
        metadatas=[{"marketplace": product.marketplace, "product": product.model_dump_json()} for product in products],
    )
    return len(products)


def process_next(app: FastAPI) -> bool:
    storage = app.state.storage
    claimed = storage.claim()
    if not claimed:
        return False
    identifier, payload = claimed
    try:
        count = upsert(app, Batch.model_validate_json(payload))
    except HTTPException as error:
        storage.finish(identifier, None, error.detail)
        log.warning(json.dumps({"event": "batch_failed", "batch_id": identifier, "status_code": error.status_code}))
    except Exception:
        storage.finish(identifier, None, "Catalog update failed. See server logs.")
        log.exception(json.dumps({"event": "batch_failed", "batch_id": identifier}))
    else:
        storage.finish(identifier, count, None)
        log.info(json.dumps({"event": "batch_completed", "batch_id": identifier, "upserted": count}))
    return True


async def batch_worker(app: FastAPI, wake: asyncio.Event, stop: asyncio.Event) -> None:
    while not stop.is_set():
        wake.clear()
        try:
            if await asyncio.to_thread(process_next, app):
                continue
        except Exception:
            log.exception(json.dumps({"event": "batch_worker_error"}))
        try:
            await asyncio.wait_for(wake.wait(), timeout=1)
        except TimeoutError:
            pass
