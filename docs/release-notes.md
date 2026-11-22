## Amazon Product Scraper v0.1.0 prerelease

- Collect Amazon product URLs in Chrome, track per-listing failures, retry eligible URLs, and export CSV or JSON.
- Save authorized product records through FastAPI into a persistent catalog, browse across marketplaces, and compare up to three products.
- Search saved listings with a relevance gate. Local mode uses listing evidence, and Gemini mode ranks eligible records with ChromaDB vector search after configuration.
- Explore a separate fictional catalog in the extension or a credential-free browser demo.

The full local stack requires Chrome, Node.js 24+, and Docker Compose v2. Gemini mode additionally needs a backend Gemini key. See the README for installation, demo mode, and tests.

Live collection was verified on two Amazon.com listings. Storefront availability and layout can change. Automated browser tests use HTML fixtures, and Gemini requests were covered with mocks. Search covers the saved catalog.

This prerelease uses ChromaDB in-process. Dependency scanning reports upstream ChromaDB server advisories in the latest available PyPI release. The supplied Compose deployment binds only the application API to localhost.
