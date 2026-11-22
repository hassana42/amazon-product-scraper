import json
import os
import subprocess
import sys

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from backend.app import create_app, gemini_embedder

HEADERS = {"X-API-Key": "test-key"}
KEYBOARD = {"asin": "B000000001", "marketplace": "US", "title": "Travel keyboard"}
LAMP = {"asin": "B000000002", "marketplace": "DE", "title": "Reading lamp"}


@pytest.fixture(autouse=True)
def default_test_mode(monkeypatch):
    monkeypatch.setenv("EMBEDDING_MODE", "gemini")


def embed(texts, task):
    return [[1.0, 0.0] if "keyboard" in text else [0.0, 1.0] for text in texts]


def test_auth_and_validation(tmp_path):
    with TestClient(create_app(api_key="test-key", chroma_path=tmp_path, embed=embed)) as client:
        assert client.get("/health").json() == {"status": "ok"}
        assert client.get("/v1/status").status_code == 401
        status = client.get("/v1/status", headers=HEADERS).json()
        assert status["mode"] in {"demo", "gemini"}
        assert status["products"] == 0
        for route in ("products", "recommendations"):
            assert client.post(f"/v1/{route}", json={}).status_code == 401
            assert client.post(f"/v1/{route}", headers={"X-API-Key": "invalid"}, json={}).status_code == 401
        for items in ([], [KEYBOARD] * 41, [dict(KEYBOARD, marketplace="XX")], [dict(KEYBOARD, asin="bad")]):
            assert client.post("/v1/products", headers=HEADERS, json={"products": items}).status_code == 422
        assert client.post("/v1/recommendations", headers=HEADERS, json={"query": "keyboard"}).json() == []
        assert (
            client.post(
                "/v1/recommendations", headers=HEADERS, json={"query": "keyboard", "marketplace": ""}
            ).status_code
            == 422
        )


def test_upsert_rank_and_filter(tmp_path):
    with TestClient(create_app(api_key="test-key", chroma_path=tmp_path, embed=embed)) as client:
        updated = dict(KEYBOARD, title="Updated travel keyboard")
        same_asin_abroad = dict(KEYBOARD, marketplace="DE", title="Compact keyboard")
        response = client.post(
            "/v1/products", headers=HEADERS, json={"products": [KEYBOARD, updated, same_asin_abroad]}
        )
        assert response.json() == {"upserted": 2}
        matches = client.post(
            "/v1/recommendations", headers=HEADERS, json={"query": "keyboard", "marketplace": None}
        ).json()
        assert {match["product"]["title"] for match in matches} == {updated["title"], same_asin_abroad["title"]}
        assert f"https://www.amazon.com/dp/{KEYBOARD['asin']}" in {match["url"] for match in matches}
        for marketplace, expected in (("DE", 1), ("CA", 0)):
            matches = client.post(
                "/v1/recommendations", headers=HEADERS, json={"query": "keyboard", "marketplace": marketplace}
            ).json()
            assert len(matches) == expected


def test_chroma_persists_across_processes(tmp_path):
    with TestClient(create_app(api_key="test-key", chroma_path=tmp_path, embed=embed)) as client:
        assert client.post("/v1/products", headers=HEADERS, json={"products": [KEYBOARD]}).is_success

    output = subprocess.check_output(
        [
            sys.executable,
            "-c",
            """
import os
from fastapi.testclient import TestClient
from backend.app import create_app
app = create_app(api_key="test-key", embed=lambda texts, task: [[1.0, 0.0]])
with TestClient(app) as client:
    response = client.post("/v1/recommendations", headers={"X-API-Key": "test-key"}, json={"query": "keyboard"})
    response.raise_for_status()
    print(response.text)
""",
        ],
        env={**os.environ, "CHROMA_PATH": str(tmp_path)},
        text=True,
        timeout=30,
    )
    assert json.loads(output)[0]["product"]["asin"] == KEYBOARD["asin"]


def test_gemini_request():
    def mock(request):
        assert request.url.path == "/v1beta/models/gemini-embedding-001:batchEmbedContents"
        assert request.headers["x-goog-api-key"] == "provider-key"
        assert json.loads(request.content)["requests"] == [
            {
                "model": "models/gemini-embedding-001",
                "content": {"parts": [{"text": "travel keyboard"}]},
                "taskType": "RETRIEVAL_QUERY",
                "outputDimensionality": 768,
            }
        ]
        return httpx.Response(200, json={"embeddings": [{"values": [0.5] * 768}]})

    with httpx.Client(
        base_url="https://example.test", headers={"x-goog-api-key": "provider-key"}, transport=httpx.MockTransport(mock)
    ) as client:
        assert gemini_embedder(client, "models/gemini-embedding-001")(["travel keyboard"], "RETRIEVAL_QUERY") == [
            [0.5] * 768
        ]


def test_gemini_failure():
    with httpx.Client(
        base_url="https://example.test", transport=httpx.MockTransport(lambda request: httpx.Response(429))
    ) as client:
        with pytest.raises(HTTPException) as failure:
            gemini_embedder(client, "models/gemini-embedding-001")(["keyboard"], "RETRIEVAL_QUERY")
        assert failure.value.status_code == 502


def wait_for_batch(client, identifier):
    from time import monotonic, sleep

    deadline = monotonic() + 8
    while monotonic() < deadline:
        response = client.get(f"/v1/batches/{identifier}", headers=HEADERS)
        response.raise_for_status()
        status = response.json()
        if status["status"] in ("completed", "failed"):
            return status
        sleep(0.05)
    pytest.fail("Batch did not reach a terminal status")


def test_durable_batch_search_and_similar(tmp_path):
    with TestClient(create_app(api_key="test-key", chroma_path=tmp_path, embed=embed)) as client:
        assert client.post("/v1/batches", json={"products": [KEYBOARD]}).status_code == 401
        assert client.post("/v1/batches", headers=HEADERS, json={"products": [KEYBOARD] * 41}).status_code == 422
        assert client.get("/v1/batches/unknown", headers=HEADERS).status_code == 404
        batch = client.post("/v1/batches", headers=HEADERS, json={"products": [KEYBOARD, LAMP]})
        assert batch.status_code == 202
        identifier = batch.json()["id"]
        assert wait_for_batch(client, identifier)["upserted"] == 2

    with TestClient(create_app(api_key="test-key", chroma_path=tmp_path, embed=embed)) as client:
        assert client.get(f"/v1/batches/{identifier}", headers=HEADERS).json()["status"] == "completed"
        assert (
            client.get("/v1/products", headers=HEADERS, params={"q": "KEYBOARD"}).json()[0]["asin"] == KEYBOARD["asin"]
        )
        path = f"/v1/products/US/{KEYBOARD['asin']}"
        assert client.get(path, headers=HEADERS).json()["title"] == KEYBOARD["title"]
        assert client.get(f"{path}/similar?market=all", headers=HEADERS).json() == []


def test_failed_batch_and_embedding_cache(tmp_path):
    calls = []

    def provider(texts, task):
        calls.append((texts, task))
        if "Broken" in texts:
            raise HTTPException(502, "Provider unavailable")
        return embed(texts, task)

    with TestClient(create_app(api_key="test-key", chroma_path=tmp_path, embed=provider)) as client:
        for _ in range(2):
            assert client.post("/v1/products", headers=HEADERS, json={"products": [KEYBOARD]}).is_success
            assert client.post("/v1/recommendations", headers=HEADERS, json={"query": "keyboard"}).is_success
        assert [task for _, task in calls] == ["RETRIEVAL_DOCUMENT", "RETRIEVAL_QUERY"]
        job = client.post("/v1/batches", headers=HEADERS, json={"products": [dict(LAMP, title="Broken")]}).json()
        result = wait_for_batch(client, job["id"])
        assert result["status"] == "failed"
        assert result["error"] == "Provider unavailable"


def test_worker_resumes_interrupted_batch(tmp_path):
    app = create_app(api_key="test-key", chroma_path=tmp_path, embed=embed)
    with TestClient(app):
        storage = app.state.storage
    identifier = storage.submit(json.dumps({"products": [KEYBOARD]}))
    assert storage.claim()[0] == identifier
    with TestClient(create_app(api_key="test-key", chroma_path=tmp_path, embed=embed)) as client:
        assert wait_for_batch(client, identifier)["upserted"] == 1


def test_chrome_cors_and_grounded_match(tmp_path):
    origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop"
    with TestClient(create_app(api_key="test-key", chroma_path=tmp_path, embed=embed)) as client:
        preflight = client.options(
            "/v1/products",
            headers={
                "Origin": origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "x-api-key,content-type",
            },
        )
        assert preflight.headers["access-control-allow-origin"] == origin
        assert client.get("/v1/status", headers={"Origin": origin}).status_code == 401
        assert (
            "access-control-allow-origin"
            not in client.get("/health", headers={"Origin": "https://unconfigured.example"}).headers
        )
        assert client.post("/v1/products", headers=HEADERS, json={"products": [KEYBOARD]}).is_success
        match = client.post("/v1/recommendations", headers=HEADERS, json={"query": "find keyboard"}).json()[0]
        assert match["matched_features"] == ["keyboard"]


def test_recent_activity_reports_persisted_outcomes(tmp_path):
    with TestClient(create_app(api_key="test-key", chroma_path=tmp_path, embed=embed)) as client:
        job = client.post("/v1/batches", headers=HEADERS, json={"products": [KEYBOARD]}).json()
        wait_for_batch(client, job["id"])
        state = client.get("/v1/status", headers=HEADERS).json()
        assert state["products"] == 1
        assert state["recent"][0]["id"] == job["id"]
        assert state["recent"][0]["status"] == "completed"


def test_search_and_similarity_default_to_us(tmp_path):
    us_lamp = dict(LAMP, marketplace="US", title="Travel keyboard lamp")
    de_peer = dict(LAMP, title="German compact keyboard")
    with TestClient(create_app(api_key="test-key", chroma_path=tmp_path, embed=embed)) as client:
        product_path = "/v1/products"
        assert client.post(product_path, headers=HEADERS, json={"products": [KEYBOARD, de_peer, us_lamp]}).is_success
        assert {row["marketplace"] for row in client.get(product_path, headers=HEADERS).json()} == {"US"}
        assert len(client.get(f"{product_path}?marketplace=all", headers=HEADERS).json()) == 3
        result = client.post("/v1/recommendations", headers=HEADERS, json={"query": "keyboard"}).json()
        assert {row["product"]["marketplace"] for row in result} == {"US"}
        path = f"{product_path}/US/{KEYBOARD['asin']}/similar"
        similar = client.get(path, headers=HEADERS).json()
        assert len(similar) == 1
        assert similar[0]["product"]["marketplace"] == "US"
        assert len(client.get(f"{path}?market=all", headers=HEADERS).json()) == 2


@pytest.mark.parametrize("mode", ["demo", "gemini"])
def test_search_relevance_and_scope(tmp_path, monkeypatch, mode):
    monkeypatch.setenv("EMBEDDING_MODE", mode)
    products = [
        {"asin": "DEMO000005", "marketplace": "US", "title": "Atlas Gaming PC", "category": "Desktop PC"},
        {"asin": "DEMO000006", "marketplace": "US", "title": "Forge Mechanical Keyboard"},
        {
            "asin": "B000000009",
            "marketplace": "US",
            "title": "Wireless Headphones",
            "description": "Pair these headphones with a gaming PC over Bluetooth.",
        },
        {"asin": "B000000010", "marketplace": "US", "title": "Basic Gaming Keyboard"},
    ]

    def provider(texts, task):
        # A deliberately perfect vector for every product still cannot pass without listing evidence.
        return [[1.0, 0.0] for _ in texts]

    with TestClient(create_app(api_key="test-key", chroma_path=tmp_path, embed=provider)) as client:
        assert client.post("/v1/products", headers=HEADERS, json={"products": products}).is_success
        for query, expected in (
            ("gaming pc", "DEMO000005"),
            ("wireless headphones", "B000000009"),
            ("mechanical keyboard", "DEMO000006"),
            ("astrophotography", None),
            ("please find me", None),
        ):
            request = {"query": query, "source": "all"}
            result = client.post("/v1/recommendations", headers=HEADERS, json=request).json()
            assert [item["product"]["asin"] for item in result] == ([expected] if expected else [])
            keyword = client.get("/v1/products", headers=HEADERS, params={"q": query, "source": "all"}).json()
            assert [item["asin"] for item in keyword] == ([expected] if expected else [])
            if result:
                assert result[0]["ranking"] == ("lexical" if mode == "demo" else "gemini")
                assert (result[0]["distance"] is None) == (mode == "demo")
        assert client.get("/v1/products", headers=HEADERS, params={"q": "gaming pc"}).json() == []
        assert client.post("/v1/recommendations", headers=HEADERS, json={"query": "gaming pc"}).json() == []
        for scope, market in (("catalog", "US"), ("demo", "DE")):
            assert (
                client.post(
                    "/v1/recommendations",
                    headers=HEADERS,
                    json={"query": "gaming pc", "source": scope, "marketplace": market},
                ).json()
                == []
            )
        assert client.post("/v1/recommendations", headers=HEADERS, json={"query": "  "}).status_code == 422


def test_vector_search_rejects_neutral_cosine_even_with_listing_evidence(tmp_path, monkeypatch):
    monkeypatch.setenv("EMBEDDING_MODE", "gemini")

    def provider(texts, task):
        return [[1.0, 0.0] if task == "RETRIEVAL_DOCUMENT" else [0.0, 1.0] for _ in texts]

    with TestClient(create_app(api_key="test-key", chroma_path=tmp_path, embed=provider)) as client:
        assert client.post("/v1/products", headers=HEADERS, json={"products": [KEYBOARD]}).is_success
        assert client.post("/v1/recommendations", headers=HEADERS, json={"query": "keyboard"}).json() == []


def test_missing_gemini_key_falls_back_to_local_mode(tmp_path, monkeypatch):
    monkeypatch.setenv("EMBEDDING_MODE", "gemini")
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    with TestClient(create_app(api_key="test-key", chroma_path=tmp_path)) as client:
        assert client.get("/v1/status", headers=HEADERS).json()["mode"] == "demo"
        assert client.post("/v1/products", headers=HEADERS, json={"products": [KEYBOARD]}).is_success
        result = client.post("/v1/recommendations", headers=HEADERS, json={"query": "keyboard"}).json()
        assert result[0]["ranking"] == "lexical"
        assert result[0]["distance"] is None
