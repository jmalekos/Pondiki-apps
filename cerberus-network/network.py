#!/usr/bin/env python3
"""Cerberus network intelligence — /network API (Phase C Overview).

Reads the local replica (rollups.db), pulled hourly from Cerberus by
cerberus-replicate.timer. Read-only; opens a fresh connection per request so
the atomic hourly replace is always picked up.

Honesty rules enforced here:
  - The volume card is "completed-flow volume", never "current bandwidth".
  - When the replica is older than 15 minutes the page reports a *paused*
    sensor, never stale numbers presented as live.
"""
import json
import os
import sqlite3
import time

from flask import Blueprint, jsonify, request

ROLLUPS_DB = "/home/cretan/cerberus-rollups/rollups.db"
DELAYED_SECONDS = 60        # Phase C current-state target
STALE_SECONDS = 120
PAUSED_SECONDS = 15 * 60    # beyond this the sensor is treated as paused

GRAINS = {60: 60, 300: 300, 3600: 3600}
RANGE_SECONDS = {"1h": 3600, "24h": 86400, "7d": 604800}
RANGE_GRAIN = {"1h": 60, "24h": 300, "7d": 3600}

bp = Blueprint("network", __name__)


def open_roll():
    if not os.path.exists(ROLLUPS_DB):
        raise sqlite3.OperationalError("rollup replica missing")
    c = sqlite3.connect("file:%s?mode=ro" % ROLLUPS_DB, uri=True)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA query_only=ON")
    return c


def _friendly(dev_id):
    """'ip:10.0.0.113' -> hostname/vendor via device_dir, else the ip."""
    return dev_id


def _state(c, now):
    try:
        row = c.execute("SELECT MAX(bucket) AS mx FROM roll_talkers WHERE grain=60").fetchone()
    except sqlite3.OperationalError:
        return {"state": "unreachable", "data_age_seconds": None, "message":
                "No rollup data present — replication has not landed yet."}
    mx = row["mx"]
    if mx is None:
        return {"state": "unreachable", "data_age_seconds": None,
                "message": "No rollup data present — replication has not landed yet."}
    age = max(0, now - mx)
    if age <= DELAYED_SECONDS:
        state, word = "live", "live"
    elif age <= STALE_SECONDS:
        state, word = "delayed", "delayed"
    elif age <= PAUSED_SECONDS:
        state, word = "stale", "stale"
    else:
        state, word = "paused", "paused"
    asof = time.strftime("%Y-%m-%d %H:%M:%S %Z", time.localtime(mx))
    return {"state": state, "word": word, "data_age_seconds": age,
            "data_as_of": asof, "last_bucket": mx}


def _grain_for_range(rng):
    return RANGE_GRAIN.get(rng, 300)


def _window(c, rng):
    """Anchor the range to the most recent recorded bucket, so a paused sensor
    still shows its last N of data instead of an empty window."""
    row = c.execute("SELECT MAX(bucket) AS hi FROM roll_talkers WHERE grain=60").fetchone()
    hi = row["hi"]
    if hi is None:
        return None, None
    lo = hi - RANGE_SECONDS.get(rng, 86400)
    return lo, hi


@bp.route("/network")
def page():
    return __import__("flask").render_template("network.html")


@bp.route("/api/network/overview")
def overview():
    rng = request.args.get("range", "24h")
    if rng not in RANGE_SECONDS:
        rng = "24h"
    now = int(time.time())
    try:
        c = open_roll()
    except sqlite3.OperationalError:
        return jsonify({"state": "unreachable", "error": "rollup replica missing"})
    try:
        state = _state(c, now)
        lookback, hi = _window(c, rng)
        # completed-flow volume over the window
        vol = c.execute(
            "SELECT direction, SUM(bytes) AS b FROM roll_talkers "
            "WHERE grain=3600 AND bucket>=? GROUP BY direction", (lookback,)).fetchall()
        down = up = 0
        for r in vol:
            if r["direction"] == "down":
                down = r["b"]
            elif r["direction"] == "up":
                up = r["b"]
        # active devices in window
        active = c.execute(
            "SELECT COUNT(DISTINCT device_id) AS n FROM roll_talkers "
            "WHERE grain=3600 AND bucket>=?", (lookback,)).fetchone()["n"]
        # findings in window
        findings = c.execute(
            "SELECT COUNT(*) AS n, "
            "SUM(CASE WHEN severity='warning' OR severity='critical' THEN 1 ELSE 0 END) AS att "
            "FROM roll_events WHERE ts>=?", (lookback,)).fetchone()
        # connectivity: probe outcomes in window (from health rollup)
        probes = c.execute(
            "SELECT COALESCE(SUM(probe_ok),0) AS ok, COALESCE(SUM(probe_fail),0) AS fail "
            "FROM roll_health WHERE grain=3600 AND bucket>=?", (lookback,)).fetchone()
        devices_total = c.execute("SELECT COUNT(*) FROM device_dir").fetchone()[0]
        return jsonify({
            "state": state,
            "range": rng,
            "cards": {
                "volume": {"down": down, "up": up, "unit": "bytes",
                           "label": "completed-flow volume",
                           "accounting_interval": "1h"},
                "active_devices": active,
                "devices_total": devices_total,
                "findings": {"total": findings["n"], "attention": findings["att"] or 0},
                "connectivity": {"ok": probes["ok"] or 0, "fail": probes["fail"] or 0},
            },
        })
    finally:
        c.close()


@bp.route("/api/network/timeline")
def timeline():
    rng = request.args.get("range", "24h")
    if rng not in RANGE_SECONDS:
        rng = "24h"
    grain = _grain_for_range(rng)
    try:
        c = open_roll()
    except sqlite3.OperationalError:
        return jsonify({"state": "unreachable", "buckets": []})
    try:
        lo, hi = _window(c, rng)
        if lo is None:
            return jsonify({"grain": grain, "range": rng, "buckets": []})
        rows = c.execute(
            "SELECT bucket, direction, SUM(bytes) AS b FROM roll_talkers "
            "WHERE grain=? AND bucket>=? GROUP BY bucket, direction ORDER BY bucket",
            (grain, lo)).fetchall()
        series = {}
        for r in rows:
            b = series.setdefault(r["bucket"], {"up": 0, "down": 0})
            b[r["direction"]] = r["b"]
        buckets = [{"t": t, "up": v["up"], "down": v["down"]}
                   for t, v in sorted(series.items())]
        return jsonify({"grain": grain, "range": rng, "buckets": buckets})
    finally:
        c.close()


@bp.route("/api/network/talkers")
def talkers():
    rng = request.args.get("range", "24h")
    if rng not in RANGE_SECONDS:
        rng = "24h"
    try:
        c = open_roll()
    except sqlite3.OperationalError:
        return jsonify({"talkers": []})
    try:
        lo, hi = _window(c, rng)
        if lo is None:
            return jsonify({"talkers": []})
        rows = c.execute(
            "SELECT device_id, "
            "SUM(CASE WHEN direction='down' THEN bytes ELSE 0 END) AS down, "
            "SUM(CASE WHEN direction='up' THEN bytes ELSE 0 END) AS up "
            "FROM roll_talkers WHERE grain=3600 AND bucket>=? "
            "GROUP BY device_id ORDER BY (down+up) DESC LIMIT 12", (lo,)).fetchall()
        # resolve ip: -> hostname/vendor via device_dir
        dd = {r["ip"]: (r["mac"], r["hostname"], r["vendor"])
              for r in c.execute("SELECT ip, mac, hostname, vendor FROM device_dir")}
        total = sum(r["down"] + r["up"] for r in rows) or 1
        out = []
        for r in rows:
            dev = r["device_id"]
            label = dev
            vendor = None
            if dev.startswith("ip:"):
                ip = dev[3:]
                if ip in dd:
                    mac, host, vend = dd[ip]
                    vendor = vend or None
                    label = host or mac or ip
            out.append({"device_id": dev, "label": label, "vendor": vendor,
                        "down": r["down"], "up": r["up"],
                        "total": r["down"] + r["up"],
                        "share": round((r["down"] + r["up"]) / total, 4)})
        return jsonify({"talkers": out})
    finally:
        c.close()


@bp.route("/api/network/findings")
def findings():
    limit = min(int(request.args.get("limit", 20)), 200)
    try:
        c = open_roll()
    except sqlite3.OperationalError:
        return jsonify({"findings": []})
    try:
        rows = c.execute(
            "SELECT ts, kind, severity, detail FROM roll_events "
            "ORDER BY ts DESC LIMIT ?", (limit,)).fetchall()
        out = []
        for r in rows:
            detail = {}
            try:
                detail = json.loads(r["detail"]) if r["detail"] else {}
            except (ValueError, TypeError):
                detail = {"raw": (r["detail"] or "")[:200]}
            out.append({"ts": r["ts"], "kind": r["kind"], "severity": r["severity"],
                        "detail": detail})
        return jsonify({"findings": out})
    finally:
        c.close()


@bp.route("/api/network/health")
def health():
    try:
        c = open_roll()
    except sqlite3.OperationalError:
        return jsonify({"state": "unreachable"})
    try:
        last = c.execute(
            "SELECT kernel_packets, kernel_drops, decoder_invalid, flow_active, uptime "
            "FROM roll_health WHERE grain=60 ORDER BY bucket DESC LIMIT 1").fetchone()
        devices = c.execute("SELECT COUNT(*) FROM device_dir").fetchone()[0]
        events = c.execute("SELECT COUNT(*) FROM roll_events").fetchone()[0]
        return jsonify({
            "state": "ok",
            "capture": {"kernel_packets": last["kernel_packets"] if last else None,
                        "kernel_drops": last["kernel_drops"] if last else None,
                        "decoder_invalid": last["decoder_invalid"] if last else None,
                        "flow_active": last["flow_active"] if last else None,
                        "note": "kernel_drops is cumulative (since Suricata start)"},
            "devices": devices,
            "events_total": events,
        })
    finally:
        c.close()
