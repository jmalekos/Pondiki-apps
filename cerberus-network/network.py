#!/usr/bin/env python3
"""Cerberus network intelligence — /network API (Phase C Overview + Phase D analysis).

Reads the local replica (rollups.db), pulled hourly from Cerberus by
cerberus-replicate.timer. Read-only; opens a fresh connection per request.

Honesty rules:
  - Volume is "completed-flow volume", never "current bandwidth".
  - Replica older than 15 min -> "paused", never stale-as-live.
  - Range windows anchor to the last recorded bucket.
"""
import html as _html
import json
import os
import sqlite3
import time

from flask import Blueprint, jsonify, request, render_template

ROLLUPS_DB = "/home/cretan/cerberus-rollups/rollups.db"
DELAYED_SECONDS = 60
STALE_SECONDS = 120
PAUSED_SECONDS = 15 * 60

RANGE_SECONDS = {"1h": 3600, "24h": 86400, "7d": 604800}
RANGE_GRAIN = {"1h": 60, "24h": 300, "7d": 3600}

RULE_LABELS = {
    "new_device": "New device",
    "unusual_volume": "Unusual transfer volume",
    "dns_failure": "Repeated DNS failures",
}

bp = Blueprint("network", __name__)


def open_roll():
    if not os.path.exists(ROLLUPS_DB):
        raise sqlite3.OperationalError("rollup replica missing")
    c = sqlite3.connect("file:%s?mode=ro" % ROLLUPS_DB, uri=True)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA query_only=ON")
    return c


def _state(c, now):
    try:
        row = c.execute("SELECT MAX(bucket) AS mx FROM roll_talkers WHERE grain=60").fetchone()
    except sqlite3.OperationalError:
        return {"state": "unreachable", "data_age_seconds": None,
                "message": "No rollup data present — replication has not landed yet."}
    mx = row["mx"]
    if mx is None:
        return {"state": "unreachable", "data_age_seconds": None,
                "message": "No rollup data present — replication has not landed yet."}
    age = max(0, now - mx)
    if age <= DELAYED_SECONDS:
        state = "live"
    elif age <= STALE_SECONDS:
        state = "delayed"
    elif age <= PAUSED_SECONDS:
        state = "stale"
    else:
        state = "paused"
    asof = time.strftime("%Y-%m-%d %H:%M:%S %Z", time.localtime(mx))
    return {"state": state, "data_age_seconds": age, "data_as_of": asof, "last_bucket": mx}


def _grain_for_range(rng):
    return RANGE_GRAIN.get(rng, 300)


def _window(c, rng):
    row = c.execute("SELECT MAX(bucket) AS hi FROM roll_talkers WHERE grain=60").fetchone()
    hi = row["hi"]
    if hi is None:
        return None, None
    return hi - RANGE_SECONDS.get(rng, 86400), hi


def _device_index(c):
    """mac -> {ip, hostname, vendor}; ip -> mac."""
    idx, ip2mac = {}, {}
    for r in c.execute("SELECT mac, ip, hostname, vendor FROM device_dir"):
        idx[r["mac"]] = {"ip": r["ip"], "hostname": r["hostname"], "vendor": r["vendor"]}
        if r["ip"]:
            ip2mac[r["ip"]] = r["mac"]
    return idx, ip2mac


def _talker_ids(c, dev_id):
    ids = [dev_id]
    if not dev_id.startswith("ip:"):
        r = c.execute("SELECT ip FROM device_dir WHERE mac=?", (dev_id,)).fetchone()
        if r and r["ip"]:
            ids.append("ip:" + r["ip"])
    return ids


def _ph(qmarks):
    return ",".join("?" * len(qmarks))


@bp.route("/network")
def page():
    return render_template("network.html")


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
        lo, hi = _window(c, rng)
        down = up = active = 0
        if lo is not None:
            for r in c.execute("SELECT direction, SUM(bytes) AS b FROM roll_talkers "
                               "WHERE grain=3600 AND bucket>=? GROUP BY direction", (lo,)):
                if r["direction"] == "down":
                    down = r["b"]
                elif r["direction"] == "up":
                    up = r["b"]
            active = c.execute("SELECT COUNT(DISTINCT device_id) FROM roll_talkers "
                               "WHERE grain=3600 AND bucket>=?", (lo,)).fetchone()[0]
        findings = c.execute(
            "SELECT COUNT(*) AS n, SUM(CASE WHEN severity!='info' THEN 1 ELSE 0 END) AS att "
            "FROM findings WHERE ts>=?", (now - RANGE_SECONDS[rng],)).fetchone()
        probes = c.execute(
            "SELECT COALESCE(SUM(probe_ok),0) AS ok, COALESCE(SUM(probe_fail),0) AS fail "
            "FROM roll_health WHERE grain=3600 AND bucket>=?", (now - RANGE_SECONDS[rng],)).fetchone()
        devices_total = c.execute("SELECT COUNT(*) FROM device_dir").fetchone()[0]
        return jsonify({
            "state": state, "range": rng,
            "cards": {
                "volume": {"down": down, "up": up, "unit": "bytes",
                           "label": "completed-flow volume", "accounting_interval": "1h"},
                "active_devices": active, "devices_total": devices_total,
                "findings": {"total": findings["n"] or 0, "attention": findings["att"] or 0},
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
        buckets = [{"t": t, "up": v["up"], "down": v["down"]} for t, v in sorted(series.items())]
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
            "SELECT device_id, SUM(CASE WHEN direction='down' THEN bytes ELSE 0 END) AS down, "
            "SUM(CASE WHEN direction='up' THEN bytes ELSE 0 END) AS up "
            "FROM roll_talkers WHERE grain=3600 AND bucket>=? GROUP BY device_id "
            "ORDER BY (down+up) DESC LIMIT 12", (lo,)).fetchall()
        idx, ip2mac = _device_index(c)
        total = sum(r["down"] + r["up"] for r in rows) or 1
        out = []
        for r in rows:
            dev = r["device_id"]
            label, vendor = dev, None
            ip = dev[3:] if dev.startswith("ip:") else None
            mac = ip2mac.get(ip) if ip else (dev if dev in idx else None)
            if mac:
                d = idx[mac]
                label = d["hostname"] or mac
                vendor = d["vendor"]
            out.append({"device_id": dev, "label": label, "vendor": vendor,
                        "down": r["down"], "up": r["up"],
                        "total": r["down"] + r["up"],
                        "share": round((r["down"] + r["up"]) / total, 4)})
        return jsonify({"talkers": out})
    finally:
        c.close()


@bp.route("/api/network/devices")
def devices():
    try:
        c = open_roll()
    except sqlite3.OperationalError:
        return jsonify({"devices": []})
    try:
        totals = {r["device_id"]: r["b"] for r in c.execute(
            "SELECT device_id, SUM(bytes) AS b FROM roll_talkers WHERE grain=3600 GROUP BY device_id")}
        idx, ip2mac = _device_index(c)
        known, seen_ips = [], set()
        for mac, d in idx.items():
            ip = d["ip"] or ""
            seen_ips.add(ip)
            total = totals.get(mac, 0) + totals.get("ip:" + ip, 0) if ip else totals.get(mac, 0)
            known.append({"device_id": mac, "label": d["hostname"] or mac, "ip": ip,
                          "vendor": d["vendor"], "total": total, "known": True})
        unknown = []
        for dev_id, b in totals.items():
            if dev_id.startswith("ip:") and dev_id[3:] not in seen_ips:
                unknown.append({"device_id": dev_id, "label": dev_id[3:], "ip": dev_id[3:],
                                "vendor": None, "total": b, "known": False})
        known.sort(key=lambda x: -x["total"])
        unknown.sort(key=lambda x: -x["total"])
        return jsonify({"devices": known + unknown})
    finally:
        c.close()


@bp.route("/api/network/device/<path:dev_id>")
def device_profile(dev_id):
    rng = request.args.get("range", "7d")
    if rng not in RANGE_SECONDS:
        rng = "7d"
    try:
        c = open_roll()
    except sqlite3.OperationalError:
        return jsonify({"error": "unreachable"})
    try:
        ids = _talker_ids(c, dev_id)
        ph = _ph(ids)
        lo, hi = _window(c, rng)
        # traffic timeline (hourly)
        tl = []
        for r in c.execute("SELECT bucket, direction, SUM(bytes) AS b FROM roll_talkers "
                           "WHERE grain=3600 AND device_id IN (%s) GROUP BY bucket, direction "
                           "ORDER BY bucket" % ph, ids):
            tl.append({"t": r["bucket"], r["direction"]: r["b"]})
        # top destinations
        dests = [{"dest_ip": r["dest_ip"], "app_proto": r["app_proto"], "bytes": r["t"]}
                 for r in c.execute("SELECT dest_ip, app_proto, SUM(bytes_down+bytes_up) AS t "
                                    "FROM roll_flows WHERE grain=3600 AND device_id IN (%s) "
                                    "GROUP BY dest_ip, app_proto ORDER BY t DESC LIMIT 12" % ph, ids)]
        # protocol mix
        protos = [{"app_proto": r["app_proto"] or "other", "bytes": r["t"]}
                  for r in c.execute("SELECT app_proto, SUM(bytes_down+bytes_up) AS t "
                                     "FROM roll_flows WHERE grain=3600 AND device_id IN (%s) "
                                     "GROUP BY app_proto ORDER BY t DESC LIMIT 10" % ph, ids)]
        # findings for this device
        fnd = [{"ts": r["ts"], "rule": r["rule"], "label": RULE_LABELS.get(r["rule"], r["rule"]),
                "severity": r["severity"], "detail": _safe_json(r["detail"])}
               for r in c.execute("SELECT ts, rule, severity, detail FROM findings "
                                  "WHERE device_id IN (%s) ORDER BY ts DESC LIMIT 20" % ph, ids)]
        idx, ip2mac = _device_index(c)
        label = dev_id
        if dev_id.startswith("ip:"):
            mac = ip2mac.get(dev_id[3:])
            if mac:
                label = idx[mac]["hostname"] or mac
        else:
            label = idx.get(dev_id, {}).get("hostname") or dev_id
        return jsonify({"device_id": dev_id, "label": label, "timeline": tl,
                        "destinations": dests, "protocols": protos, "findings": fnd})
    finally:
        c.close()


@bp.route("/api/network/destinations")
def destinations():
    rng = request.args.get("range", "24h")
    if rng not in RANGE_SECONDS:
        rng = "24h"
    try:
        c = open_roll()
    except sqlite3.OperationalError:
        return jsonify({"destinations": []})
    try:
        lo, hi = _window(c, rng)
        if lo is None:
            return jsonify({"destinations": []})
        rows = [{"dest_ip": r["dest_ip"], "app_proto": r["app_proto"], "bytes": r["t"]}
                for r in c.execute("SELECT dest_ip, app_proto, SUM(bytes_down+bytes_up) AS t "
                                   "FROM roll_flows WHERE grain=3600 AND bucket>=? "
                                   "GROUP BY dest_ip, app_proto ORDER BY t DESC LIMIT 25", (lo,))]
        return jsonify({"destinations": rows})
    finally:
        c.close()


@bp.route("/api/network/protocols")
def protocols():
    rng = request.args.get("range", "24h")
    if rng not in RANGE_SECONDS:
        rng = "24h"
    try:
        c = open_roll()
    except sqlite3.OperationalError:
        return jsonify({"protocols": []})
    try:
        lo, hi = _window(c, rng)
        if lo is None:
            return jsonify({"protocols": []})
        rows = [{"app_proto": r["app_proto"] or "other", "bytes": r["t"]}
                for r in c.execute("SELECT app_proto, SUM(bytes_down+bytes_up) AS t "
                                   "FROM roll_flows WHERE grain=3600 AND bucket>=? "
                                   "GROUP BY app_proto ORDER BY t DESC LIMIT 15", (lo,))]
        return jsonify({"protocols": rows})
    finally:
        c.close()


@bp.route("/api/network/trends")
def trends():
    try:
        c = open_roll()
    except sqlite3.OperationalError:
        return jsonify({"days": []})
    try:
        rows = c.execute(
            "SELECT bucket/86400 AS day, direction, SUM(bytes) AS b FROM roll_talkers "
            "WHERE grain=3600 GROUP BY day, direction ORDER BY day").fetchall()
        by_day = {}
        for r in rows:
            d = by_day.setdefault(r["day"], {"up": 0, "down": 0})
            d[r["direction"]] = r["b"]
        days = [{"day": d, "ts": d * 86400, "up": v["up"], "down": v["down"],
                 "total": v["up"] + v["down"]} for d, v in sorted(by_day.items())]
        return jsonify({"days": days})
    finally:
        c.close()


@bp.route("/api/network/diagnostics")
def diagnostics():
    try:
        c = open_roll()
    except sqlite3.OperationalError:
        return jsonify({"outages": []})
    try:
        rows = [{"ts": r["bucket"], "target": r["target"], "kind": r["kind"],
                 "ok": r["ok"], "fail": r["fail"], "last_error": r["last_error"]}
                for r in c.execute("SELECT bucket, target, kind, ok, fail, last_error "
                                   "FROM roll_probes WHERE fail > 0 ORDER BY bucket DESC LIMIT 100")]
        return jsonify({"outages": rows})
    finally:
        c.close()


@bp.route("/api/network/findings")
def findings():
    limit = min(int(request.args.get("limit", 25)), 200)
    try:
        c = open_roll()
    except sqlite3.OperationalError:
        return jsonify({"findings": []})
    try:
        out = [{"ts": r["ts"], "rule": r["rule"], "label": RULE_LABELS.get(r["rule"], r["rule"]),
                "device_id": r["device_id"], "severity": r["severity"],
                "detail": _safe_json(r["detail"])}
               for r in c.execute("SELECT ts, rule, device_id, severity, detail FROM findings "
                                  "ORDER BY ts DESC LIMIT ?", (limit,))]
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
        last = c.execute("SELECT kernel_packets, kernel_drops, decoder_invalid, flow_active, uptime "
                         "FROM roll_health WHERE grain=60 ORDER BY bucket DESC LIMIT 1").fetchone()
        devices = c.execute("SELECT COUNT(*) FROM device_dir").fetchone()[0]
        events = c.execute("SELECT COUNT(*) FROM roll_events").fetchone()[0]
        findings_n = c.execute("SELECT COUNT(*) FROM findings").fetchone()[0]
        return jsonify({"state": "ok",
                        "capture": {"kernel_packets": last["kernel_packets"] if last else None,
                                    "kernel_drops": last["kernel_drops"] if last else None,
                                    "decoder_invalid": last["decoder_invalid"] if last else None,
                                    "flow_active": last["flow_active"] if last else None,
                                    "note": "kernel_drops is cumulative (since Suricata start)"},
                        "devices": devices, "events_total": events, "findings_total": findings_n})
    finally:
        c.close()


@bp.route("/api/network/report")
def report():
    """Deterministic executive summary (HTML, print-to-PDF). No LLM."""
    rng = request.args.get("range", "24h")
    if rng not in RANGE_SECONDS:
        rng = "24h"
    try:
        c = open_roll()
    except sqlite3.OperationalError:
        return "<html><body>Unreachable</body></html>", 503
    try:
        now = int(time.time())
        state = _state(c, now)
        lo, hi = _window(c, rng)
        down = up = active = 0
        if lo is not None:
            v = {r["direction"]: r["b"] for r in c.execute(
                "SELECT direction, SUM(bytes) AS b FROM roll_talkers WHERE grain=3600 AND bucket>=? GROUP BY direction", (lo,))}
            down, up = v.get("down", 0), v.get("up", 0)
            active = c.execute("SELECT COUNT(DISTINCT device_id) FROM roll_talkers WHERE grain=3600 AND bucket>=?", (lo,)).fetchone()[0]
        talkers = c.execute(
            "SELECT device_id, SUM(CASE WHEN direction='down' THEN bytes ELSE 0 END) d, "
            "SUM(CASE WHEN direction='up' THEN bytes ELSE 0 END) u FROM roll_talkers "
            "WHERE grain=3600 AND bucket>=? GROUP BY device_id ORDER BY (d+u) DESC LIMIT 10", (lo,)).fetchall()
        dests = c.execute(
            "SELECT dest_ip, app_proto, SUM(bytes_down+bytes_up) t FROM roll_flows "
            "WHERE grain=3600 AND bucket>=? GROUP BY dest_ip, app_proto ORDER BY t DESC LIMIT 10", (lo,)).fetchall()
        fnd = c.execute("SELECT ts, rule, device_id, severity FROM findings ORDER BY ts DESC LIMIT 15").fetchall()
        drops = c.execute("SELECT kernel_drops FROM roll_health WHERE grain=60 ORDER BY bucket DESC LIMIT 1").fetchone()
        def fb(n):
            if n >= 1e9:
                return "%.2f GB" % (n / 1e9)
            if n >= 1e6:
                return "%.1f MB" % (n / 1e6)
            return str(n) + " B"
        idx, _ = _device_index(c)
        def dev_label(d):
            if d.startswith("ip:"):
                mac = _ip2mac(c, d[3:])
                if mac and idx.get(mac, {}).get("hostname"):
                    return idx[mac]["hostname"]
                return d[3:]
            return idx.get(d, {}).get("hostname") or d
        rows_t = "".join("<tr><td>%s</td><td>%s</td><td>%s</td></tr>" % (
            esc(dev_label(t["device_id"])), fb(t["d"]), fb(t["u"])) for t in talkers)
        rows_d = "".join("<tr><td>%s</td><td>%s</td><td>%s</td></tr>" % (
            esc(d["dest_ip"]), esc(d["app_proto"] or ""), fb(d["t"])) for d in dests)
        rows_f = "".join("<tr><td>%s</td><td>%s</td><td>%s</td><td>%s</td></tr>" % (
            RULE_LABELS.get(f["rule"], f["rule"]), esc(f["device_id"] or ""), esc(f["severity"] or ""),
            time.strftime("%m-%d %H:%M", time.localtime(f["ts"]))) for f in fnd)
        html = ("<!DOCTYPE html><html><head><meta charset='utf-8'><title>Cerberus network report</title>"
                "<style>body{font-family:-apple-system,sans-serif;max-width:800px;margin:24px auto;color:#111}"
                "h1{font-size:22px}table{border-collapse:collapse;width:100%%;margin:12px 0}"
                "th,td{text-align:left;padding:6px 10px;border-bottom:1px solid #ddd;font-size:13px}"
                "th{color:#555;font-size:11px;text-transform:uppercase}.muted{color:#666}</style></head><body>"
                "<h1>Cerberus network report</h1>"
                "<p class='muted'>Range: %s · data as of %s · state: %s</p>"
                "<p><b>Completed-flow volume</b> — down %s · up %s · active devices %d</p>"
                "<h2>Top talkers</h2><table><tr><th>Device</th><th>Down</th><th>Up</th></tr>%s</table>"
                "<h2>Top destinations</h2><table><tr><th>Destination</th><th>App</th><th>Volume</th></tr>%s</table>"
                "<h2>Findings</h2><table><tr><th>Rule</th><th>Device</th><th>Severity</th><th>Time</th></tr>%s</table>"
                "<p class='muted'>Capture drops (cumulative): %s. Deterministic report — no LLM, no live-rate claim.</p>"
                "</body></html>") % (rng, state["data_as_of"], state["state"], fb(down), fb(up), active,
                                     rows_t, rows_d, rows_f,
                                     (str(drops["kernel_drops"]) if drops else "n/a"))
        return html
    finally:
        c.close()


@bp.route("/api/network/export.csv")
def export_csv():
    kind = request.args.get("kind", "talkers")
    rng = request.args.get("range", "24h")
    if rng not in RANGE_SECONDS:
        rng = "24h"
    try:
        c = open_roll()
    except sqlite3.OperationalError:
        return "unreachable", 503
    try:
        lo, hi = _window(c, rng)
        if lo is None:
            return "no data", 200
        import csv as _csv, io
        buf = io.StringIO()
        w = _csv.writer(buf)
        if kind == "flows":
            w.writerow(["device_id", "dest_ip", "app_proto", "proto", "bytes_down", "bytes_up", "flows"])
            for r in c.execute("SELECT device_id, dest_ip, app_proto, proto, bytes_down, bytes_up, flows "
                               "FROM roll_flows WHERE grain=3600 AND bucket>=? ORDER BY bytes_down+bytes_up DESC LIMIT 5000", (lo,)):
                w.writerow([r["device_id"], r["dest_ip"], r["app_proto"], r["proto"], r["bytes_down"], r["bytes_up"], r["flows"]])
        else:
            w.writerow(["device_id", "direction", "bytes", "pkts", "flows"])
            for r in c.execute("SELECT device_id, direction, bytes, pkts, flows FROM roll_talkers "
                               "WHERE grain=3600 AND bucket>=? ORDER BY bytes DESC LIMIT 5000", (lo,)):
                w.writerow([r["device_id"], r["direction"], r["bytes"], r["pkts"], r["flows"]])
        return buf.getvalue(), 200, {"Content-Type": "text/csv",
                                     "Content-Disposition": "attachment; filename=cerberus-%s-%s.csv" % (kind, rng)}
    finally:
        c.close()


def _ip2mac(c, ip):
    r = c.execute("SELECT mac FROM device_dir WHERE ip=?", (ip,)).fetchone()
    return r["mac"] if r else None


def esc(s):
    return _html.escape(str(s))


def _safe_json(s):
    try:
        return json.loads(s) if s else {}
    except (ValueError, TypeError):
        return {"raw": (s or "")[:200]}
