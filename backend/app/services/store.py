"""Stores for executions, explanations, patches and REA results.

Each store keeps a small in-memory LRU cache (so a record fetched twice is the
same object) in front of an optional SQLite table, so data survives restarts.
Rows are zlib-compressed JSON; old rows are pruned beyond `max_entries`.
"""

import dataclasses
import json
import sqlite3
import threading
import time
import zlib
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Generic, Optional, TypeVar

from app.services.sandbox import SandboxResult

T = TypeVar("T")


class BoundedStore(Generic[T]):
    """Thread-safe LRU map, optionally persisted to a SQLite table (write-through)."""

    def __init__(
        self,
        max_entries: int,
        db: Optional["Database"] = None,
        table: str = "",
        encode: Callable[[T], dict[str, Any]] = lambda v: v,  # type: ignore[assignment,return-value]
        decode: Callable[[dict[str, Any]], T] = lambda d: d,  # type: ignore[assignment,return-value]
        cache_entries: int = 200,
        owner: Callable[[T], Optional[str]] = lambda v: None,
    ):
        self._max = max_entries
        self._cache_max = min(cache_entries, max_entries)
        self._items: "OrderedDict[str, T]" = OrderedDict()
        self._lock = threading.Lock()
        self._db = db
        self._table = table
        self._encode = encode
        self._decode = decode
        self._owner = owner
        if db is not None:
            db.ensure_table(table)

    def _remember(self, key: str, value: T) -> None:
        self._items[key] = value
        self._items.move_to_end(key)
        limit = self._cache_max if self._db is not None else self._max
        while len(self._items) > limit:
            self._items.popitem(last=False)

    def put(self, key: str, value: T) -> None:
        with self._lock:
            self._remember(key, value)
        if self._db is not None:
            self._db.save(self._table, key, self._encode(value), self._max, self._owner(value))

    def get(self, key: str) -> Optional[T]:
        with self._lock:
            if key in self._items:
                self._items.move_to_end(key)
                return self._items[key]
        if self._db is None:
            return None
        data = self._db.load(self._table, key)
        if data is None:
            return None
        value = self._decode(data)
        with self._lock:
            self._remember(key, value)
        return value

    def delete(self, key: str) -> bool:
        with self._lock:
            found = self._items.pop(key, None) is not None
        if self._db is not None:
            found = self._db.delete(self._table, key) or found
        return found

    def delete_owned_by(self, owner: str) -> None:
        with self._lock:
            for key in [k for k, v in self._items.items() if self._owner(v) == owner]:
                del self._items[key]
        if self._db is not None:
            self._db.delete_owner(self._table, owner)

    def purge_older_than(self, cutoff: float) -> int:
        with self._lock:
            self._items.clear()  # cheap and safe: the cache refills from disk on demand
        return self._db.purge(self._table, cutoff) if self._db is not None else 0


class Database:
    """Minimal key/value persistence on SQLite (stdlib, no server)."""

    def __init__(self, path: str):
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._lock = threading.Lock()
        self._tables: set[str] = set()

    def ensure_table(self, table: str) -> None:
        if not table.isidentifier():
            raise ValueError(f"bad table name {table!r}")
        with self._lock:
            self._conn.execute(
                f"CREATE TABLE IF NOT EXISTS {table} "
                f"(key TEXT PRIMARY KEY, created REAL NOT NULL, data BLOB NOT NULL, owner TEXT)"
            )
            columns = {row[1] for row in self._conn.execute(f"PRAGMA table_info({table})")}
            if "owner" not in columns:  # databases created before run deletion existed
                self._conn.execute(f"ALTER TABLE {table} ADD COLUMN owner TEXT")
            self._conn.execute(f"CREATE INDEX IF NOT EXISTS {table}_created ON {table}(created)")
            self._conn.execute(f"CREATE INDEX IF NOT EXISTS {table}_owner ON {table}(owner)")
            self._conn.commit()
            self._tables.add(table)

    def save(self, table: str, key: str, value: dict[str, Any], max_rows: int, owner: Optional[str] = None) -> None:
        blob = zlib.compress(json.dumps(value, separators=(",", ":")).encode("utf-8"), 6)
        with self._lock:
            self._conn.execute(
                f"INSERT INTO {table}(key, created, data, owner) VALUES (?, ?, ?, ?) "
                f"ON CONFLICT(key) DO UPDATE SET data = excluded.data",
                (key, time.time(), blob, owner),
            )
            self._conn.execute(
                f"DELETE FROM {table} WHERE key IN (SELECT key FROM {table} ORDER BY created DESC LIMIT -1 OFFSET ?)",
                (max_rows,),
            )
            self._conn.commit()

    def load(self, table: str, key: str) -> Optional[dict[str, Any]]:
        with self._lock:
            row = self._conn.execute(f"SELECT data FROM {table} WHERE key = ?", (key,)).fetchone()
        return json.loads(zlib.decompress(row[0])) if row else None

    def delete(self, table: str, key: str) -> bool:
        with self._lock:
            cur = self._conn.execute(f"DELETE FROM {table} WHERE key = ?", (key,))
            self._conn.commit()
        return cur.rowcount > 0

    def delete_owner(self, table: str, owner: str) -> None:
        with self._lock:
            self._conn.execute(f"DELETE FROM {table} WHERE owner = ?", (owner,))
            self._conn.commit()

    def purge(self, table: str, cutoff: float) -> int:
        with self._lock:
            cur = self._conn.execute(f"DELETE FROM {table} WHERE created < ?", (cutoff,))
            self._conn.commit()
        return cur.rowcount

    def close(self) -> None:
        with self._lock:
            self._conn.close()


@dataclass
class ExecutionRecord:
    source: str
    result: SandboxResult
    created_at: float = field(default_factory=time.time)
    files: dict[str, str] = field(default_factory=dict)
    stdin: str = ""

    def sources(self) -> dict[str, str]:
        return {"main.py": self.source, **self.files}


@dataclass
class ExplanationRecord:
    execution_id: str
    step: int
    payload: dict[str, Any]  # the API response body


@dataclass
class PatchRecord:
    patch_id: str
    execution_id: str
    original: str
    patched: str
    diff: str
    rationale: str
    provider: str
    status: str = "proposed"  # proposed | validated | failed | untested
    validation: Optional[dict[str, Any]] = None


def _decode_execution(d: dict[str, Any]) -> ExecutionRecord:
    return ExecutionRecord(source=d["source"], result=SandboxResult(**d["result"]), created_at=d["created_at"],
                           files=d.get("files", {}), stdin=d.get("stdin", ""))


class Stores:
    def __init__(self, max_entries: int, db_path: str = ""):
        self.db = Database(db_path) if db_path else None
        asdict = dataclasses.asdict
        self.executions: BoundedStore[ExecutionRecord] = BoundedStore(
            max_entries, self.db, "executions", asdict, _decode_execution, cache_entries=50
        )
        self.explanations: BoundedStore[ExplanationRecord] = BoundedStore(
            max_entries, self.db, "explanations", asdict, lambda d: ExplanationRecord(**d),
            owner=lambda r: r.execution_id,
        )
        self.patches: BoundedStore[PatchRecord] = BoundedStore(
            max_entries, self.db, "patches", asdict, lambda d: PatchRecord(**d), owner=lambda r: r.execution_id
        )
        # Full REA evidence documents can be large; keep a few in memory only.
        self.rea_results: BoundedStore[dict[str, Any]] = BoundedStore(50)

    def delete_execution(self, execution_id: str) -> bool:
        """Remove a run and everything derived from it (explanations, patches)."""
        found = self.executions.delete(execution_id)
        self.explanations.delete_owned_by(execution_id)
        self.patches.delete_owned_by(execution_id)
        return found

    def purge(self, retention_seconds: float) -> int:
        """Delete everything older than the retention window. Returns rows removed."""
        cutoff = time.time() - retention_seconds
        return sum(s.purge_older_than(cutoff) for s in (self.executions, self.explanations, self.patches))

    def close(self) -> None:
        if self.db is not None:
            self.db.close()
