"""Exercise a running demo API with sample product data using only the standard library."""

import argparse
import json
import os
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", default="http://127.0.0.1:8000")
    parser.add_argument("--verify-existing", action="store_true")
    args = parser.parse_args()
    headers = {"X-API-Key": os.environ["SCRAPER_API_KEY"], "Content-Type": "application/json"}

    def call(path, payload=None):
        body = json.dumps(payload).encode() if payload is not None else None
        with urlopen(Request(args.origin + path, data=body, headers=headers), timeout=10) as response:
            return json.load(response)

    assert call("/health") == {"status": "ok"}
    try:
        call("/api/v2/heartbeat")
    except HTTPError as error:
        assert error.code == 404
    else:
        raise AssertionError("The ChromaDB server API must not be mounted")
    fixture = Path(__file__).resolve().parents[1] / "extension/static/demo-products.json"
    samples = json.loads(fixture.read_text())
    if not args.verify_existing:
        job = call("/v1/batches", {"products": samples})
        for _ in range(100):
            job = call(f"/v1/batches/{job['id']}")
            if job["status"] in {"completed", "failed"}:
                break
            time.sleep(0.1)
        assert job["status"] == "completed", job
        assert job["upserted"] == len(samples), job

    results = call(
        "/v1/recommendations",
        {
            "query": "Affordable wireless headphones with good battery life",
            "marketplace": "US",
            "source": "demo",
        },
    )
    assert results[0]["product"]["asin"] == "DEMO000001", results
    assert any("30-hour battery life" in reason for reason in results[0]["reasons"])
    assert call("/v1/products/US/DEMO000001")["price"] == "$39.99"
    assert call("/v1/products/US/DEMO000001/similar?limit=1&source=demo")[0]["product"]["asin"] == "DEMO000002"
    for query, expected in [("gaming pc", "DEMO000005"), ("mechanical keyboard", "DEMO000006")]:
        matches = call("/v1/recommendations", {"query": query, "source": "demo"})
        assert [match["product"]["asin"] for match in matches] == [expected], matches
    assert call("/v1/recommendations", {"query": "astrophotography", "source": "demo"}) == []
    print("Demo catalog, batch status, ranking, explanations, and similarity verified.")


if __name__ == "__main__":
    main()
