"""
§1-2 Feed wrappers — every external data source returns a Field, never a bare scalar.
None/error is distinct from a real 0.0. Hardcoded values are structurally illegal.
"""
import os
import sys
import logging
from datetime import datetime, timezone
from typing import Optional, Any
import requests

# Flexible path discovery — works on Pi and local workspace
_PONDIKI_ROOT = os.environ.get("PONDIKI_ROOT", "/home/cretan/.openclaw/workspace")
sys.path.insert(0, os.path.join(_PONDIKI_ROOT, "projects/trading-bot-claude"))
sys.path.insert(0, os.path.join(_PONDIKI_ROOT, "tools"))

from .provenance import Field, make_field, TTL

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# BTC Price
# ---------------------------------------------------------------------------

def fetch_btc_price() -> Field:
    """Fetch current BTC price from Yahoo Finance."""
    try:
        import yfinance as yf
        ticker = yf.Ticker("BTC-USD")
        data = ticker.history(period="1d")
        if data.empty:
            return make_field(None, "yahoo:BTC-USD", TTL["btc_price"])
        
        price = float(data["Close"].iloc[-1])
        fetched_at = datetime.now(timezone.utc)
        # Override default timestamp with actual close time
        if hasattr(data.index[-1], 'to_pydatetime'):
            fetched_at = data.index[-1].to_pydatetime()
            if fetched_at.tzinfo is None:
                from datetime import timezone as tz
                fetched_at = fetched_at.replace(tzinfo=tz.utc)
        
        return make_field(price, "yahoo:BTC-USD", TTL["btc_price"], fetched_at=fetched_at)
    except Exception as e:
        logger.error(f"BTC price fetch failed: {e}")
        return Field(
            value=None, source="yahoo:BTC-USD",
            fetched_at=datetime.now(timezone.utc).isoformat(),
            ttl=TTL["btc_price"], status="error"
        )


def fetch_price_history(days: int = 30) -> list[dict]:
    """Fetch BTC price history for chart data. Returns list of {date, close}."""
    try:
        import yfinance as yf
        import pandas as pd
        from datetime import timedelta
        
        end = datetime.now()
        start = end - timedelta(days=days)
        btc = yf.download("BTC-USD", start=start.strftime("%Y-%m-%d"),
                          end=end.strftime("%Y-%m-%d"), progress=False)
        if btc.empty:
            return []
        
        if isinstance(btc.columns, pd.MultiIndex):
            close_col = [c for c in btc.columns if "Close" in str(c)][0]
        else:
            close_col = "Close"
        
        history = []
        for idx, row in btc.iterrows():
            date_str = idx.strftime("%Y-%m-%d") if hasattr(idx, "strftime") else str(idx)[:10]
            history.append({
                "date": date_str,
                "close": float(row[close_col])
            })
        return history
    except Exception as e:
        logger.error(f"Price history fetch failed: {e}")
        return []


# ---------------------------------------------------------------------------
# Fear & Greed
# ---------------------------------------------------------------------------

def fetch_fear_greed() -> Field:
    """Fetch Fear & Greed Index from alternative.me. Returns Field, never a hardcoded scalar."""
    try:
        r = requests.get("https://api.alternative.me/fng/", timeout=10)
        if r.status_code != 200:
            return Field(
                value=None, source="alternative.me/fng",
                fetched_at=datetime.now(timezone.utc).isoformat(),
                ttl=TTL["fear_greed"], status="error"
            )
        data = r.json()
        value = int(data["data"][0]["value"])
        return make_field(value, "alternative.me/fng", TTL["fear_greed"])
    except Exception as e:
        logger.error(f"F&G fetch failed: {e}")
        return Field(
            value=None, source="alternative.me/fng",
            fetched_at=datetime.now(timezone.utc).isoformat(),
            ttl=TTL["fear_greed"], status="error"
        )


# ---------------------------------------------------------------------------
# Funding Rate (Deribit)
# ---------------------------------------------------------------------------

def fetch_funding_rate() -> Field:
    """Fetch BTC perpetual funding rate from Deribit. 
    
    Returns funding_8h as a decimal (e.g. 0.0001 = 0.01% per 8h).
    None/error is distinct from a real 0.0 — the streak engine treats them differently.
    """
    try:
        url = "https://www.deribit.com/api/v2/public/ticker"
        r = requests.get(url, params={"instrument_name": "BTC-PERPETUAL"}, timeout=10)
        if r.status_code != 200:
            return Field(
                value=None, source="deribit:BTC-PERP",
                fetched_at=datetime.now(timezone.utc).isoformat(),
                ttl=TTL["funding_8h"], status="error"
            )
        result = r.json().get("result", {})
        
        # Prefer funding_8h (the settled 8h rate)
        funding_8h = result.get("funding_8h")
        if funding_8h is not None:
            return make_field(float(funding_8h), "deribit:BTC-PERP", TTL["funding_8h"])
        
        # Fallback to current_funding (the live estimate)
        current_funding = result.get("current_funding")
        if current_funding is not None:
            return make_field(float(current_funding), "deribit:BTC-PERP", TTL["funding_8h"])
        
        return make_field(None, "deribit:BTC-PERP", TTL["funding_8h"])
    except Exception as e:
        logger.error(f"Funding rate fetch failed: {e}")
        return Field(
            value=None, source="deribit:BTC-PERP",
            fetched_at=datetime.now(timezone.utc).isoformat(),
            ttl=TTL["funding_8h"], status="error"
        )


# ---------------------------------------------------------------------------
# Options Sentiment (Deribit, via pondiki_tools)
# ---------------------------------------------------------------------------

def fetch_options_sentiment() -> dict[str, Any]:
    """Fetch options data. Returns raw dict for regime/display use.
    Individual numeric fields carry provenance via the caller.
    """
    try:
        import pondiki_tools as pt
        snapshot = pt.get_deribit_options_snapshot()
        if not snapshot:
            return {"error": "Empty Deribit snapshot", "is_valid": False}
        
        is_valid = snapshot.get("is_valid")
        if is_valid is False:
            return {
                "btc_price": snapshot.get("btc_price"),
                "put_call_ratio": None,
                "volume_weighted_pcr": None,
                "skew": None,
                "sentiment": None,
                "max_oi": None,
                "term_structure": None,
                "is_valid": False,
                "pcr_interpretation": None,
            }
        
        result = {
            "btc_price": snapshot.get("btc_price"),
            "put_call_ratio": snapshot.get("put_call_ratio"),
            "volume_weighted_pcr": snapshot.get("volume_weighted_pcr"),
            "skew": snapshot.get("skew"),
            "sentiment": snapshot.get("option_market_sentiment"),
            "max_oi": snapshot.get("max_oi_levels"),
            "term_structure": snapshot.get("term_structure_summary"),
            "is_valid": is_valid,
        }
        
        pcr = result["put_call_ratio"]
        if pcr is not None:
            if pcr > 3.0:
                result["pcr_interpretation"] = "Very bearish/hedged"
            elif pcr > 1.5:
                result["pcr_interpretation"] = "Bearish"
            elif pcr > 0.8:
                result["pcr_interpretation"] = "Neutral"
            else:
                result["pcr_interpretation"] = "Bullish"
        else:
            result["pcr_interpretation"] = None
        
        return result
    except Exception as e:
        logger.error(f"Options fetch failed: {e}")
        return {"error": str(e), "is_valid": False}


# ---------------------------------------------------------------------------
# Macro Snapshot (FRED, via pondiki_tools)
# ---------------------------------------------------------------------------

def fetch_macro_snapshot() -> dict[str, Any]:
    """Fetch FRED macro indicators. Returns raw dict."""
    try:
        import pondiki_tools as pt
        snapshot = pt.get_fred_macro_snapshot()
        if not snapshot:
            return {"error": "Empty FRED snapshot"}
        
        def safe_float(val, default=None):
            if val is None:
                return default
            try:
                return float(val)
            except (ValueError, TypeError):
                return default
        
        fed_val = safe_float(snapshot.get("FEDFUNDS", {}).get("value"))
        treas_val = safe_float(snapshot.get("DGS10", {}).get("value"))
        vix_val = safe_float(snapshot.get("VIXCLS", {}).get("value"))
        yc_msg = snapshot.get("yield_curve", {}).get("message")
        
        result = {
            "fed_funds": fed_val,
            "treasury_10y": treas_val,
            "vix": vix_val,
            "yield_curve": yc_msg,
        }
        
        if vix_val is not None:
            if vix_val > 30:
                result["volatility_regime"] = "High fear"
            elif vix_val > 20:
                result["volatility_regime"] = "Elevated"
            else:
                result["volatility_regime"] = "Calm"
        else:
            result["volatility_regime"] = "Unknown"
        
        result["curve_signal"] = "Warning" if (yc_msg and "inverted" in str(yc_msg).lower()) else "Normal"
        return result
    except Exception as e:
        logger.error(f"Macro fetch failed: {e}")
        return {"error": str(e)}
