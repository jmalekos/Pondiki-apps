"""
§1 Provenance-or-nothing — Field type + stamp() freshness enforcement.
No bare scalars in the pipeline. Every value is a Field.
"""
from dataclasses import dataclass, asdict
from datetime import datetime, timedelta, timezone
from typing import Literal, Any, Optional

Status = Literal["ok", "stale", "error", "missing"]


@dataclass(frozen=True)
class Field:
    """A pipeline value with provenance. Never construct a bare scalar.
    
    Construction: use make_field() - a Field cannot be created without
    a source and a real fetch time. This is what makes `fg = 15` illegal.
    """
    value: Any
    source: str          # e.g. "alternative.me/fng", "deribit:BTC-PERP", "coingecko"
    fetched_at: str      # ISO-8601 UTC instant the underlying fetch resolved
    ttl: float           # max age in seconds before the value is considered stale
    status: Status = "ok"


def make_field(
    value: Any,
    source: str,
    ttl: float,
    fetched_at: Optional[datetime] = None,
) -> Field:
    """Construct a Field. None value → status='missing'. No other path yields a bare scalar."""
    if value is None:
        return Field(
            value=None,
            source=source,
            fetched_at=(fetched_at or datetime.now(timezone.utc)).isoformat(),
            ttl=ttl,
            status="missing",
        )
    return Field(
        value=value,
        source=source,
        fetched_at=(fetched_at or datetime.now(timezone.utc)).isoformat(),
        ttl=ttl,
        status="ok",
    )


def stamp(field: Field, now: Optional[datetime] = None) -> Field:
    """Recompute status against the clock at render/serialize time.
    
    Called once per field at snapshot generation time. If the field is already
    in error/missing state, that status is preserved.
    """
    now = now or datetime.now(timezone.utc)
    if field.status in ("error", "missing"):
        return field
    try:
        fetched = datetime.fromisoformat(field.fetched_at)
    except (ValueError, TypeError):
        return Field(
            value=field.value,
            source=field.source,
            fetched_at=field.fetched_at,
            ttl=field.ttl,
            status="stale",
        )
    fresh = (now - fetched).total_seconds() <= field.ttl
    return Field(
        value=field.value,
        source=field.source,
        fetched_at=field.fetched_at,
        ttl=field.ttl,
        status="ok" if fresh else "stale",
    )


def field_to_dict(field: Field) -> dict:
    """Serialize a Field to dict for snapshot.json."""
    d = asdict(field)
    return d


# TTL table (§2) — canonical freshness bounds for every feed
TTL = {
    "btc_price": 60,           # tightest — spot price
    "funding_8h": 900,         # 15 min — perp funding cadence
    "fear_greed": 21600,       # 6 h — index is daily; >1 cycle old = fail
    "vix": 86400,              # 24 h — daily close; flag off-hours
    "ust_10y": 86400,          # 24 h — daily
    "fed_funds": 172800,       # 48 h — slow-moving
    "options": 300,            # 5 min — Deribit snapshot
    "regime": None,            # derived — computed as min(input TTLs)
    "streak": None,            # derived — computed as min(input TTLs)
    "snapshot": 900,           # 15 min — snapshot-level guard
}
