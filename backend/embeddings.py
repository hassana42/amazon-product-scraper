import json
import logging
import math
from collections.abc import Callable
from typing import Literal

import httpx
from fastapi import HTTPException

Task = Literal["RETRIEVAL_DOCUMENT", "RETRIEVAL_QUERY"]
Embed = Callable[[list[str], Task], list[list[float]]]
MODEL = "models/gemini-embedding-001"
log = logging.getLogger("uvicorn.error")


def gemini_embedder(client: httpx.Client, model: str) -> Embed:
    def embed(texts: list[str], task: Task) -> list[list[float]]:
        try:
            response = client.post(
                f"/v1beta/{model}:batchEmbedContents",
                json={
                    "requests": [
                        {
                            "model": model,
                            "content": {"parts": [{"text": text}]},
                            "taskType": task,
                            "outputDimensionality": 768,
                        }
                        for text in texts
                    ]
                },
            )
            response.raise_for_status()
            vectors = [item["values"] for item in response.json()["embeddings"]]
            if len(vectors) != len(texts) or any(
                len(vector) != 768 or not all(math.isfinite(value) for value in vector) for vector in vectors
            ):
                raise ValueError("Unexpected embedding shape or values")
            return vectors
        except (httpx.HTTPError, KeyError, TypeError, ValueError) as error:
            log.warning(json.dumps({"event": "embedding_failed", "error_type": type(error).__name__}))
            raise HTTPException(
                502, "Gemini embedding request failed. Check provider configuration or retry."
            ) from error

    return embed
