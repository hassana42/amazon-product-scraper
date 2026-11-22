import hashlib
import json
import re
import sqlite3
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4


class Storage:
    def __init__(self, path: Path):
        self.path = path
        with self.connect() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS batches (
                    id TEXT PRIMARY KEY, payload TEXT NOT NULL, status TEXT NOT NULL,
                    submitted_at TEXT DEFAULT CURRENT_TIMESTAMP, upserted INTEGER,
                    error TEXT
                );
                CREATE INDEX IF NOT EXISTS batches_by_status ON batches(status);
                CREATE TABLE IF NOT EXISTS vectors (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                UPDATE batches SET status = 'queued' WHERE status = 'processing';
            """)

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def submit(self, payload: str) -> str:
        identifier = uuid4().hex
        with self.connect() as db:
            db.execute("INSERT INTO batches(id, payload, status) VALUES (?, ?, 'queued')", (identifier, payload))
        return identifier

    def status(self, identifier: str) -> dict | None:
        with self.connect() as db:
            result = db.execute(
                "SELECT id, status, submitted_at, upserted, error FROM batches WHERE id = ?",
                (identifier,),
            ).fetchone()
        return dict(result) if result else None

    def recent(self) -> list[dict]:
        with self.connect() as db:
            rows = db.execute(
                "SELECT id, status, submitted_at, upserted, error FROM batches ORDER BY rowid DESC LIMIT 5"
            )
            return [dict(row) for row in rows]

    def claim(self) -> tuple[str, str] | None:
        with self.connect() as db:
            result = db.execute("""
                UPDATE batches SET status = 'processing' WHERE id = (
                    SELECT id FROM batches WHERE status = 'queued' ORDER BY rowid LIMIT 1
                ) RETURNING id, payload
            """).fetchone()
        return (result["id"], result["payload"]) if result else None

    def finish(self, identifier: str, upserted: int | None, error: str | None) -> None:
        with self.connect() as db:
            db.execute(
                "UPDATE batches SET status=?, upserted=?, error=? WHERE id=?",
                ("failed" if error else "completed", upserted, error, identifier),
            )

    def embeddings(self, namespace: str, embed: Callable) -> Callable:
        def cached(texts: list[str], task: str) -> list[list[float]]:
            keys = [hashlib.sha256(json.dumps([namespace, task, text]).encode()).hexdigest() for text in texts]
            unique = dict(zip(keys, texts, strict=True))
            placeholders = ",".join("?" for _ in unique)
            with self.connect() as db:
                rows = db.execute(f"SELECT key, value FROM vectors WHERE key IN ({placeholders})", tuple(unique))
                values = {row["key"]: json.loads(row["value"]) for row in rows}
            missing = [key for key in unique if key not in values]
            if missing:
                fresh = dict(zip(missing, embed([unique[key] for key in missing], task), strict=True))
                with self.connect() as db:
                    db.executemany(
                        "INSERT OR IGNORE INTO vectors VALUES (?, ?)",
                        [(key, json.dumps(vector)) for key, vector in fresh.items()],
                    )
                values.update(fresh)
            return [values[key] for key in keys]

        return cached


def demo_embed(texts: list[str], _task: str) -> list[list[float]]:
    vectors = []
    for text in texts:
        vector = [0.0] * 768
        for token in re.findall(r"\w+", text.lower()):
            digest = hashlib.blake2s(token.encode(), digest_size=4).digest()
            vector[int.from_bytes(digest, "big") % len(vector)] += 1.0
        if not any(vector):
            vector[0] = 1.0
        vectors.append(vector)
    return vectors
