"""Evidence gates and deterministic ranking for a product catalog."""

import re
import unicodedata
from dataclasses import dataclass

from backend.models import Product

FILLER = {
    "a",
    "an",
    "and",
    "best",
    "by",
    "find",
    "for",
    "from",
    "good",
    "great",
    "high",
    "long",
    "me",
    "of",
    "please",
    "show",
    "the",
    "to",
    "top",
    "under",
    "with",
}
# Product nouns must be supported by identity fields, rather than incidental compatibility text.
TYPES = {
    "pc",
    "desktop",
    "laptop",
    "keyboard",
    "mouse",
    "monitor",
    "headphone",
    "headset",
    "earbud",
    "speaker",
    "webcam",
    "microphone",
    "charger",
    "hub",
    "lamp",
    "ssd",
    "controller",
}
ALIASES = {
    "pcs": "pc",
    "desktops": "desktop",
    "laptops": "laptop",
    "keyboards": "keyboard",
    "mice": "mouse",
    "mouses": "mouse",
    "monitors": "monitor",
    "headphones": "headphone",
    "headsets": "headset",
    "earbuds": "earbud",
    "speakers": "speaker",
    "webcams": "webcam",
    "microphones": "microphone",
    "chargers": "charger",
    "hubs": "hub",
    "lamps": "lamp",
    "ssds": "ssd",
    "controllers": "controller",
}
COMPATIBLE_TERMS = {
    "pc": "desktop",
    "desktop": "pc",
    "headphone": "headset",
    "headset": "headphone",
    "wireless": "bluetooth",
}


def demo_record(product: Product) -> bool:
    return bool(re.fullmatch(r"DEMO\d{6}", product.asin))


def tokens(value: str) -> list[str]:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return list(
        dict.fromkeys(ALIASES.get(term, term) for term in re.findall(r"[^\W_]+", normalized) if term not in FILLER)
    )


@dataclass(frozen=True)
class Evidence:
    matched: list[str]
    identity_matches: int
    relevant: bool


def evidence(terms: list[str], product: Product) -> Evidence:
    identity = set(tokens(" ".join(filter(None, [product.title, product.category, product.brand]))))
    content = identity | set(tokens(product.description))
    matched = []
    anchored = 0
    for term in terms:
        alias = COMPATIBLE_TERMS.get(term, term)
        if term in identity or alias in identity:
            anchored += 1
            matched.append(term if term in identity else alias)
        elif term not in TYPES and (term in content or alias in content):
            matched.append(term if term in content else alias)
    return Evidence(matched, anchored, bool(terms) and len(matched) == len(terms) and anchored > 0)


def similarity_terms(source: Product) -> list[str]:
    category_types = [term for term in tokens(source.category or "") if term in TYPES]
    return category_types or [term for term in tokens(source.title) if term in TYPES]


def related(source: Product, candidate: Product) -> Evidence:
    types = similarity_terms(source)
    if not types:
        return evidence(tokens(source.category or source.title), candidate)
    for term in types:
        result = evidence([term], candidate)
        if result.relevant:
            return result
    return Evidence([], 0, False)
