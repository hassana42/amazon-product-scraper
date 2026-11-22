# Contributing

Keep live storefront requests out of automated tests. Use listing fixtures for parser and browser coverage, and mock the Gemini provider. When reporting a collection failure, include the marketplace, the product URL if public, and the error state. Remove credentials, cookies, or personal data from logs and screenshots.

See the [test commands](README.md#tests) before submitting a change. Relevance changes should include examples that should match and examples that should return an empty result. Include the local or Gemini mode when reporting ranking behavior.
