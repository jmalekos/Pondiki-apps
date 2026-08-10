"""
BTC//TERMINAL Pipeline — Contract-compliant main entrypoint.
§1-3: All values are Fields with provenance. Streak is a pure function.
Emits snapshot.json for §4 self-publish and §5 client-side rendering.
"""
import os
import sys
import json
import logging
from datetime import datetime, timezone, timedelta

# Flexible path discovery
_PONDIKI_ROOT = os.environ.get("PONDIKI_ROOT", "/home/cretan/.openclaw/workspace")
sys.path.insert(0, os.path.join(_PONDIKI_ROOT, "projects/trading-bot-claude"))
sys.path.insert(0, os.path.join(_PONDIKI_ROOT, "tools"))

import pandas as pd
import numpy as np
import yfinance as yf

from .provenance import Field, make_field, stamp, field_to_dict, TTL, Status
from .feeds import (
    fetch_btc_price, fetch_fear_greed, fetch_funding_rate,
    fetch_options_sentiment, fetch_macro_snapshot, fetch_price_history,
)
from .streak import (
    funding_streak_days, append_funding_datum, load_funding_history,
)

# Import regime classifier (external dependency)
try:
    from strategies.regime_classifier_v2 import RuleBasedRegimeClassifierV2, RegimeV2, BullSubRegime
    _REGIME_AVAILABLE = True
except ImportError:
    _REGIME_AVAILABLE = False

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Regime classification
# ---------------------------------------------------------------------------

def classify_regime() -> dict:
    """Run regime classifier. Returns dict with final_regime, confidence, checks, etc."""
    if not _REGIME_AVAILABLE:
        return {
            "final_regime": "RANGE_BOUND",
            "confidence": 0.5,
            "checks": [],
            "is_fallback": True,
            "details": {"reason": "regime classifier not available"},
        }
    
    try:
        end = datetime.now()
        start = end - timedelta(days=210)
        btc = yf.download("BTC-USD", start=start.strftime("%Y-%m-%d"),
                          end=end.strftime("%Y-%m-%d"), progress=False)
        
        if btc.empty:
            raise ValueError("No BTC data")
        
        if isinstance(btc.columns, pd.MultiIndex):
            btc.columns = ['_'.join(col).strip().lower() for col in btc.columns.values]
        else:
            btc.columns = [c.lower() for c in btc.columns]
        
        column_map = {}
        for col in btc.columns:
            if 'close' in col: column_map[col] = 'close'
            elif 'open' in col: column_map[col] = 'open'
            elif 'high' in col: column_map[col] = 'high'
            elif 'low' in col: column_map[col] = 'low'
            elif 'volume' in col: column_map[col] = 'volume'
        btc = btc.rename(columns=column_map)
        
        essential = ['open', 'high', 'low', 'close', 'volume']
        btc = btc[[c for c in essential if c in btc.columns]].copy()
        
        classifier = RuleBasedRegimeClassifierV2(lookback_days=200)
        classifier.update_data(btc)
        
        result = classifier.run_continuous()
        scalar = classifier.get_position_scalar(result)
        dte, delta = classifier.get_options_dte_delta(result)
        
        return {
            "final_regime": result.regime.name,
            "sub_regime": result.sub_regime.value if result.sub_regime else None,
            "confidence": result.confidence,
            "details": result.details,
            "position_scalar": scalar,
            "options_dte": dte,
            "options_delta": delta,
            "checks": [],
            "is_fallback": result.details.get("reason") == "fallback" if result.details else False,
        }
    except Exception as e:
        logger.error(f"Regime classification failed: {e}")
        return {
            "final_regime": "RANGE_BOUND",
            "confidence": 0.5,
            "checks": [],
            "is_fallback": True,
            "details": {"reason": f"error: {e}"},
        }


# ---------------------------------------------------------------------------
# Snapshot generation
# ---------------------------------------------------------------------------

def generate_snapshot(output_path: str) -> dict:
    """Run the full pipeline and write snapshot.json.
    
    Returns the snapshot dict. Every value carries provenance.
    """
    now = datetime.now(timezone.utc)
    
    # --- Fetch all fields ---
    
    # BTC price
    btc_field = fetch_btc_price()
    btc_field = stamp(btc_field, now)
    
    # Fear & Greed (was hardcoded to 15 — now a live API call)
    fg_field = fetch_fear_greed()
    fg_field = stamp(fg_field, now)
    
    # Funding rate
    funding_field = fetch_funding_rate()
    funding_field = stamp(funding_field, now)
    
    # Record funding history if we got a valid rate
    if funding_field.status == "ok" and funding_field.value is not None:
        append_funding_datum(funding_field.value)
    
    # Compute pure streak from rolling history
    streak_value = None
    if funding_field.status == "ok" and funding_field.value is not None:
        history = load_funding_history()
        if history:
            streak_value = funding_streak_days(history)
    
    # Streak as a derived Field — TTL = min(funding TTL)
    streak_field = Field(
        value=streak_value,
        source="derived:funding_streak_days(deribit:BTC-PERP)",
        fetched_at=now.isoformat(),
        ttl=TTL["funding_8h"],
        status=funding_field.status,  # inherits parent status
    )
    streak_field = stamp(streak_field, now)
    
    # Options
    options_raw = fetch_options_sentiment()
    options_fetched_at = now.isoformat()
    
    # Macro
    macro_raw = fetch_macro_snapshot()
    macro_fetched_at = now.isoformat()
    
    # Regime
    regime_raw = classify_regime()
    
    # Price history for charts
    price_history = fetch_price_history(days=30)
    
    # --- Build fields map ---
    
    # Wrap macro values in provenance
    macro_vix = None
    if macro_raw.get("vix") is not None:
        macro_vix = stamp(make_field(macro_raw["vix"], "FRED:VIXCLS", TTL["vix"]), now)
    
    macro_10y = None
    if macro_raw.get("treasury_10y") is not None:
        macro_10y = stamp(make_field(macro_raw["treasury_10y"], "FRED:DGS10", TTL["ust_10y"]), now)
    
    macro_fed = None
    if macro_raw.get("fed_funds") is not None:
        macro_fed = stamp(make_field(macro_raw["fed_funds"], "FRED:FEDFUNDS", TTL["fed_funds"]), now)
    
    # Build the full snapshot
    snapshot = {
        "generated_at": now.isoformat(),
        "fields": {
            "btc_price": field_to_dict(btc_field),
            "fear_greed": field_to_dict(fg_field),
            "funding_8h": field_to_dict(funding_field),
            "funding_streak_days": field_to_dict(streak_field),
            "vix": field_to_dict(macro_vix) if macro_vix else {
                "value": None, "source": "FRED:VIXCLS",
                "fetched_at": macro_fetched_at, "ttl": TTL["vix"], "status": "error"
            },
            "ust_10y": field_to_dict(macro_10y) if macro_10y else {
                "value": None, "source": "FRED:DGS10",
                "fetched_at": macro_fetched_at, "ttl": TTL["ust_10y"], "status": "error"
            },
            "fed_funds": field_to_dict(macro_fed) if macro_fed else {
                "value": None, "source": "FRED:FEDFUNDS",
                "fetched_at": macro_fetched_at, "ttl": TTL["fed_funds"], "status": "error"
            },
        },
        "options": {
            **options_raw,
            "_fetched_at": options_fetched_at,
        },
        "macro": {
            **macro_raw,
            "_fetched_at": macro_fetched_at,
        },
        "regime": regime_raw,
        "price_history": price_history,
        "_schema_version": 2,
    }
    
    with open(output_path, "w") as f:
        json.dump(snapshot, f, indent=2, default=str)
    
    logger.info(f"Snapshot written to {output_path} ({len(price_history)} price points)")
    
    # Log field status summary
    for name, fdict in snapshot["fields"].items():
        status = fdict.get("status", "?")
        value_repr = str(fdict.get("value"))[:40] if fdict.get("value") is not None else "None"
        logger.info(f"  {name}: {status:7s} | {value_repr}")
    
    return snapshot


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    import argparse
    parser = argparse.ArgumentParser(description="BTC//TERMINAL Pipeline")
    parser.add_argument("--emit", default="snapshot.json", help="Output path for snapshot.json")
    args = parser.parse_args()
    
    generate_snapshot(args.emit)


if __name__ == "__main__":
    main()
