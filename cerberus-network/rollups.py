#!/usr/bin/env python3
"""Cerberus network intelligence — rollup + retention worker.

Reads the authoritative raw aggregate database (net.db) and maintains a small,
dashboard-facing rollup database (rollups.db) with three time grains:

  grain 60    (1m)  -> 30 day retention
  grain 300   (5m)  -> 90 day retention
  grain 3600  (1h)  -> 365 day retention

Idempotent: _meta['last_1m_bucket'] tracks the high-water mark. Each run
processes new 1m buckets (with a 5-minute overlap to absorb late data), then
re-derives the coarser grains and prunes retention.

Subcommands:
  rollups.py rollup [--net PATH] [--roll PATH]   incremental rollup + retention
  rollups.py export --roll PATH --out PATH       consistent snapshot + sha256
  rollups.py status [--roll PATH]                health snapshot (JSON)

The worker only ever *reads* net.db (attached read-only). The raw archive is
the authority.
"""
import argparse
import hashlib
import json
import os
import sqlite3
import sys
import time

RETENTION = {60: 30 * 86400, 300: 90 * 86400, 3600: 365 * 86400}

SCHEMA = """
CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS device_dir (
  mac TEXT PRIMARY KEY, ip TEXT, hostname TEXT, vendor TEXT,
  first_seen INTEGER, last_seen INTEGER);
CREATE TABLE IF NOT EXISTS roll_talkers (
  grain INTEGER NOT NULL, bucket INTEGER NOT NULL, device_id TEXT NOT NULL,
  direction TEXT NOT NULL, bytes INTEGER NOT NULL, pkts INTEGER NOT NULL,
  flows INTEGER NOT NULL, PRIMARY KEY (grain, bucket, device_id, direction)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS roll_dns (
  grain INTEGER NOT NULL, bucket INTEGER NOT NULL, src_ip TEXT NOT NULL,
  rrname TEXT NOT NULL, rrtype TEXT NOT NULL, rcode TEXT NOT NULL,
  count INTEGER NOT NULL, PRIMARY KEY (grain, bucket, src_ip, rrname, rrtype, rcode)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS roll_tls (
  grain INTEGER NOT NULL, bucket INTEGER NOT NULL, src_ip TEXT NOT NULL,
  sni TEXT NOT NULL, version TEXT NOT NULL, count INTEGER NOT NULL,
  PRIMARY KEY (grain, bucket, src_ip, sni, version)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS roll_health (
  grain INTEGER NOT NULL, bucket INTEGER NOT NULL, kernel_packets INTEGER,
  kernel_drops INTEGER, decoder_invalid INTEGER, flow_active INTEGER,
  uptime INTEGER, probe_ok INTEGER, probe_fail INTEGER, event_count INTEGER,
  PRIMARY KEY (grain, bucket)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_talkers_bucket ON roll_talkers(bucket);
CREATE INDEX IF NOT EXISTS idx_dns_bucket ON roll_dns(bucket);
CREATE INDEX IF NOT EXISTS idx_tls_bucket ON roll_tls(bucket);
CREATE INDEX IF NOT EXISTS idx_health_bucket ON roll_health(bucket);
CREATE TABLE IF NOT EXISTS roll_events (
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL,
  kind TEXT, severity TEXT, detail TEXT);
CREATE INDEX IF NOT EXISTS idx_events_ts ON roll_events(ts);
"""


def open_rw(path):
    c = sqlite3.connect(path)
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA synchronous=NORMAL")
    c.execute("PRAGMA temp_store=MEMORY")
    c.execute("PRAGMA foreign_keys=OFF")
    return c


def open_ro(path):
    c = sqlite3.connect("file:%s?mode=ro" % path, uri=True)
    c.execute("PRAGMA query_only=ON")
    return c


def get_meta(con, key, default=None):
    row = con.execute("SELECT value FROM _meta WHERE key=?", (key,)).fetchone()
    return default if row is None else row[0]


def set_meta(con, key, value):
    con.execute("INSERT INTO _meta(key,value) VALUES(?,?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))


def rebuild_device_dir(roll):
    roll.execute("DELETE FROM device_dir")
    roll.execute("""
        INSERT OR REPLACE INTO device_dir(mac,ip,hostname,vendor,first_seen,last_seen)
        SELECT COALESCE(mac,''), COALESCE(ip,''), COALESCE(hostname,''),
               COALESCE(vendor,''), first_seen, last_seen FROM net.devices""")


def roll_1m(roll, lo, hi):
    """Roll raw 1m buckets in (lo, hi] into grain=60 tables."""
    # talkers: up = bytes_toserver, down = bytes_toclient
    roll.execute("""
    INSERT OR REPLACE INTO roll_talkers (grain,bucket,device_id,direction,bytes,pkts,flows)
    SELECT 60, bucket,
           CASE WHEN src_mac IS NOT NULL AND src_mac<>'' THEN src_mac
                ELSE 'ip:'||COALESCE(NULLIF(src_ip,''),'?') END AS device_id,
           'up' AS direction, SUM(bytes_toserver), SUM(pkts), SUM(flows)
    FROM net.flow_agg WHERE bucket>? AND bucket<=?
    GROUP BY bucket, 2
    """, (lo, hi))
    roll.execute("""
    INSERT OR REPLACE INTO roll_talkers (grain,bucket,device_id,direction,bytes,pkts,flows)
    SELECT 60, bucket,
           CASE WHEN src_mac IS NOT NULL AND src_mac<>'' THEN src_mac
                ELSE 'ip:'||COALESCE(NULLIF(src_ip,''),'?') END AS device_id,
           'down' AS direction, SUM(bytes_toclient), SUM(pkts), SUM(flows)
    FROM net.flow_agg WHERE bucket>? AND bucket<=?
    GROUP BY bucket, 2
    """, (lo, hi))

    roll.execute("""
    INSERT OR REPLACE INTO roll_dns (grain,bucket,src_ip,rrname,rrtype,rcode,count)
    SELECT 60, bucket, COALESCE(NULLIF(src_ip,''),'?'), COALESCE(NULLIF(rrname,''),'?'),
           COALESCE(NULLIF(rrtype,''),'?'), COALESCE(NULLIF(rcode,''),'?'), SUM(count)
    FROM net.dns_agg WHERE bucket>? AND bucket<=? GROUP BY bucket,2,3,4,5
    """, (lo, hi))

    roll.execute("""
    INSERT OR REPLACE INTO roll_tls (grain,bucket,src_ip,sni,version,count)
    SELECT 60, bucket, COALESCE(NULLIF(src_ip,''),'?'), COALESCE(NULLIF(sni,''),'?'),
           COALESCE(NULLIF(version,''),'?'), SUM(count)
    FROM net.tls_agg WHERE bucket>? AND bucket<=? GROUP BY bucket,2,3,4
    """, (lo, hi))

    # health — merge stats / probes / events into one row per (grain,bucket)
    roll.execute("""
    INSERT INTO roll_health (grain,bucket,kernel_packets,kernel_drops,decoder_invalid,
                             flow_active,uptime,probe_ok,probe_fail,event_count)
    SELECT 60, bucket, SUM(kernel_packets), SUM(kernel_drops), SUM(decoder_invalid),
           MAX(flow_active), MAX(uptime), 0, 0, 0
    FROM net.stats WHERE bucket>? AND bucket<=? GROUP BY bucket
    ON CONFLICT(grain,bucket) DO UPDATE SET
      kernel_packets=excluded.kernel_packets, kernel_drops=excluded.kernel_drops,
      decoder_invalid=excluded.decoder_invalid, flow_active=excluded.flow_active,
      uptime=excluded.uptime
    """, (lo, hi))

    roll.execute("""
    INSERT INTO roll_health (grain,bucket,kernel_packets,kernel_drops,decoder_invalid,
                             flow_active,uptime,probe_ok,probe_fail,event_count)
    SELECT 60, (ts/60)*60, 0, 0, 0, 0, 0,
           SUM(CASE WHEN ok=1 THEN 1 ELSE 0 END), SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END), 0
    FROM net.probes WHERE ts>? AND ts<=? GROUP BY 2
    ON CONFLICT(grain,bucket) DO UPDATE SET
      probe_ok=excluded.probe_ok, probe_fail=excluded.probe_fail
    """, (lo, hi))

    roll.execute("""
    INSERT INTO roll_health (grain,bucket,kernel_packets,kernel_drops,decoder_invalid,
                             flow_active,uptime,probe_ok,probe_fail,event_count)
    SELECT 60, (ts/60)*60, 0, 0, 0, 0, 0, 0, 0, COUNT(*)
    FROM net.events WHERE ts>? AND ts<=? GROUP BY 2
    ON CONFLICT(grain,bucket) DO UPDATE SET event_count=excluded.event_count
    """, (lo, hi))

    # local findings (Suricata anomalies + probe events)
    roll.execute("""
    INSERT OR REPLACE INTO roll_events (id, ts, kind, severity, detail)
    SELECT id, ts, kind, severity, detail FROM net.events WHERE id>?
    """, (get_meta(roll, "last_event_id", 0),))
    row = roll.execute("SELECT COALESCE(MAX(id),0) FROM roll_events").fetchone()
    set_meta(roll, "last_event_id", str(row[0]))


def roll_grain(roll, grain, lo_aligned):
    """Re-derive a coarser grain from grain=60 rows >= lo_aligned (idempotent)."""
    step = grain
    roll.execute("""
    INSERT OR REPLACE INTO roll_talkers (grain,bucket,device_id,direction,bytes,pkts,flows)
    SELECT ?, (bucket/?)*?, device_id, direction, SUM(bytes), SUM(pkts), SUM(flows)
    FROM roll_talkers WHERE grain=60 AND bucket>=? GROUP BY 2,3,4
    """, (grain, step, step, lo_aligned))
    roll.execute("""
    INSERT OR REPLACE INTO roll_dns (grain,bucket,src_ip,rrname,rrtype,rcode,count)
    SELECT ?, (bucket/?)*?, src_ip, rrname, rrtype, rcode, SUM(count)
    FROM roll_dns WHERE grain=60 AND bucket>=? GROUP BY 2,3,4,5,6
    """, (grain, step, step, lo_aligned))
    roll.execute("""
    INSERT OR REPLACE INTO roll_tls (grain,bucket,src_ip,sni,version,count)
    SELECT ?, (bucket/?)*?, src_ip, sni, version, SUM(count)
    FROM roll_tls WHERE grain=60 AND bucket>=? GROUP BY 2,3,4,5
    """, (grain, step, step, lo_aligned))
    roll.execute("""
    INSERT OR REPLACE INTO roll_health (grain,bucket,kernel_packets,kernel_drops,decoder_invalid,
                             flow_active,uptime,probe_ok,probe_fail,event_count)
    SELECT ?, (bucket/?)*?, SUM(kernel_packets), SUM(kernel_drops), SUM(decoder_invalid),
           MAX(flow_active), MAX(uptime), SUM(probe_ok), SUM(probe_fail), SUM(event_count)
    FROM roll_health WHERE grain=60 AND bucket>=? GROUP BY 2
    """, (grain, step, step, lo_aligned))


def prune(roll, now):
    for grain, keep in RETENTION.items():
        cutoff = now - keep
        for t in ("roll_talkers", "roll_dns", "roll_tls", "roll_health"):
            roll.execute("DELETE FROM %s WHERE grain=? AND bucket<?" % t, (grain, cutoff))
    roll.execute("DELETE FROM roll_events WHERE ts < ?", (now - 90 * 86400,))


def do_rollup(net_path, roll_path):
    roll = open_rw(roll_path)
    try:
        roll.executescript(SCHEMA)
        roll.execute("ATTACH DATABASE 'file:%s?mode=ro' AS net" % net_path)
        now = int(time.time())
        mn, mx = roll.execute("SELECT MIN(bucket), MAX(bucket) FROM net.flow_agg").fetchone()
        if mx is None:
            print("net.flow_agg is empty; nothing to roll up")
            return {"new": 0, "last_1m_bucket": None}
        lo = get_meta(roll, "last_1m_bucket", None)
        if lo is None:
            lo = mn - 1  # full backfill
        else:
            lo = max(int(lo) - 300, mn - 1)  # 5-min overlap for late data
        hi = mx
        roll_1m(roll, lo, hi)
        base = max(lo, mn - 1)
        roll_grain(roll, 300, (base // 300) * 300)
        roll_grain(roll, 3600, (base // 3600) * 3600)
        rebuild_device_dir(roll)
        prune(roll, now)
        roll.commit()
        set_meta(roll, "last_1m_bucket", str(hi))
        set_meta(roll, "last_run", str(now))
        set_meta(roll, "source_max_bucket", str(mx))
        roll.commit()
        print("rolled up 1m buckets (%d, %d] -> last=%s" % (lo, hi, hi))
        return {"new": max(0, hi - lo) // 60, "last_1m_bucket": hi}
    finally:
        roll.close()


def do_export(roll_path, out_path):
    src = sqlite3.connect("file:%s?mode=ro" % roll_path, uri=True)
    try:
        dst = sqlite3.connect(out_path)
        try:
            src.backup(dst)  # consistent snapshot, handles WAL
        finally:
            dst.close()
    finally:
        src.close()
    os.chmod(out_path, 0o644)
    sha = hashlib.sha256()
    with open(out_path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            sha.update(chunk)
    digest = sha.hexdigest()
    side = out_path + ".sha256"
    with open(side, "w") as f:
        f.write(digest + "  " + os.path.basename(out_path) + "\n")
    os.chmod(side, 0o644)
    print(json.dumps({"path": out_path, "bytes": os.path.getsize(out_path),
                      "sha256": digest}))


def do_status(roll_path):
    roll = open_ro(roll_path)
    try:
        out = {"rollups_db": roll_path}
        for t in ("roll_talkers", "roll_dns", "roll_tls", "roll_health"):
            out[t] = roll.execute("SELECT COUNT(*) FROM %s" % t).fetchone()[0]
        out["last_1m_bucket"] = get_meta(roll, "last_1m_bucket")
        out["last_run"] = get_meta(roll, "last_run")
        out["devices"] = roll.execute("SELECT COUNT(*) FROM device_dir").fetchone()[0]
        out["events"] = roll.execute("SELECT COUNT(*) FROM roll_events").fetchone()[0]
        print(json.dumps(out, indent=2))
    finally:
        roll.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["rollup", "export", "status"])
    ap.add_argument("--net", default="/srv/cerberus-data/cerberus-net/net.db")
    ap.add_argument("--roll", default="/srv/cerberus-data/cerberus-net/rollups.db")
    ap.add_argument("--out", default="/srv/cerberus-data/cerberus-net/rollups-export.db")
    a = ap.parse_args()
    if a.cmd == "rollup":
        do_rollup(a.net, a.roll)
    elif a.cmd == "export":
        do_export(a.roll, a.out)
    elif a.cmd == "status":
        do_status(a.roll)


if __name__ == "__main__":
    main()
