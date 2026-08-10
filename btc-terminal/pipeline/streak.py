"""
§3 Pure funding streak — recomputed from rolling history, never mutated.
No seed, no state file, no K33 counter. Idempotent: same history ⇒ same result.
"""
from datetime import datetime, timedelta, timezone
from typing import Optional
import json
import os
import logging

logger = logging.getLogger(__name__)

HISTORY_FILE = "/tmp/btc_funding_history.json"
MAX_HISTORY_DAYS = 180  # keep up to 6 months


def funding_streak_days(
    history: list[tuple[datetime, float]],  # chronological (ts, rate_8h)
    neutral_eps: float = 1e-5,
    period_hours: int = 8,
) -> int:
    """Signed streak in days from a rolling window of funding rates.
    
    Walk newest→oldest:
      • strictly negative period → extends a negative run
      • strictly positive period → terminates the run
      • |rate| < neutral_eps → NEUTRAL: transparent — neither extends nor breaks
    
    Pure & idempotent: same history ⇒ same result. No seed, no mutation.
    Returns negative for bearish streak, positive for bullish.
    """
    run = 0
    for _, rate in reversed(history):
        if abs(rate) < neutral_eps:
            continue  # hold, don't decay
        if rate < 0:
            run += 1
        else:
            break  # genuine positive flip ends the streak
    return -round(run * period_hours / 24)


def append_funding_datum(rate_8h: float, ts: Optional[datetime] = None):
    """Record a funding rate observation to the rolling history file.
    
    Appends to JSON array, keeping only the last MAX_HISTORY_DAYS.
    """
    ts = ts or datetime.now(timezone.utc)
    
    history = []
    if os.path.exists(HISTORY_FILE):
        try:
            with open(HISTORY_FILE, "r") as f:
                raw = json.load(f)
            history = [(datetime.fromisoformat(r[0]), r[1]) for r in raw]
        except (json.JSONDecodeError, OSError, IndexError) as e:
            logger.warning(f"Funding history corrupt, resetting: {e}")
    
    history.append((ts, rate_8h))
    
    # Prune old entries
    cutoff = ts - timedelta(days=MAX_HISTORY_DAYS)
    history = [(t, r) for t, r in history if t > cutoff]
    
    try:
        with open(HISTORY_FILE, "w") as f:
            json.dump([(t.isoformat(), r) for t, r in history], f)
    except OSError as e:
        logger.warning(f"Failed to write funding history: {e}")


def load_funding_history() -> list[tuple[datetime, float]]:
    """Load the rolling funding history from disk."""
    if not os.path.exists(HISTORY_FILE):
        return []
    try:
        with open(HISTORY_FILE, "r") as f:
            raw = json.load(f)
        return [(datetime.fromisoformat(r[0]), r[1]) for r in raw]
    except (json.JSONDecodeError, OSError, IndexError):
        return []
