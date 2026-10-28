-- Cerberus network intelligence — dashboard rollup schema (rollups.db)
-- Maintained by rollups.py. Read-only for the dashboard / Flask API.

CREATE TABLE IF NOT EXISTS _meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Device directory snapshot from net.db.devices
CREATE TABLE IF NOT EXISTS device_dir (
  mac TEXT PRIMARY KEY,
  ip TEXT, hostname TEXT, vendor TEXT,
  first_seen INTEGER, last_seen INTEGER
);

-- Device-level completed-flow volume, by direction and time grain.
-- direction: 'up' (bytes_toserver) | 'down' (bytes_toclient)
CREATE TABLE IF NOT EXISTS roll_talkers (
  grain INTEGER NOT NULL,
  bucket INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  pkts INTEGER NOT NULL,
  flows INTEGER NOT NULL,
  PRIMARY KEY (grain, bucket, device_id, direction)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS roll_dns (
  grain INTEGER NOT NULL,
  bucket INTEGER NOT NULL,
  src_ip TEXT NOT NULL, rrname TEXT NOT NULL, rrtype TEXT NOT NULL, rcode TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (grain, bucket, src_ip, rrname, rrtype, rcode)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS roll_tls (
  grain INTEGER NOT NULL,
  bucket INTEGER NOT NULL,
  src_ip TEXT NOT NULL, sni TEXT NOT NULL, version TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (grain, bucket, src_ip, sni, version)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS roll_health (
  grain INTEGER NOT NULL,
  bucket INTEGER NOT NULL,
  kernel_packets INTEGER, kernel_drops INTEGER, decoder_invalid INTEGER,
  flow_active INTEGER, uptime INTEGER,
  probe_ok INTEGER, probe_fail INTEGER,
  event_count INTEGER,
  PRIMARY KEY (grain, bucket)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_talkers_bucket ON roll_talkers(bucket);
CREATE INDEX IF NOT EXISTS idx_dns_bucket ON roll_dns(bucket);
CREATE INDEX IF NOT EXISTS idx_tls_bucket ON roll_tls(bucket);
CREATE INDEX IF NOT EXISTS idx_health_bucket ON roll_health(bucket);
CREATE INDEX IF NOT EXISTS idx_events_ts ON roll_events(ts);

-- Local findings: Suricata anomalies + probe outages/recoveries from net.db.events
CREATE TABLE IF NOT EXISTS roll_events (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  kind TEXT, severity TEXT, detail TEXT
);
