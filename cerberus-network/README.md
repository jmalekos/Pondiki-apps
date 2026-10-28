# Cerberus Network Intelligence — local-first build

Phase A–C vertical slice of the Cerberus network intelligence product
(PRD v2.2, `docs/prd/cerberus-network-intelligence-v2.2.md`). This replaces the
alerts-only Next.js MVP (`cerberus-dashboard/web`, now archived).

## Architecture

```
Cerberus (sensor Pi 5, SSD)                    clawdnode (this Pi)
  Suricata 7.0.10 -> eve.json
  netmetrics.py -> net.db (raw authority)        ops console (Flask :8788)
        |                                          /network page + API
        v                                            |
  rollups.py (root, 5-min timer) --------------------|
     -> rollups.db (3 grains, retention)             |
  rollups.py export -> rollups-export.db + sha256    |
        |                                            v
        +-------- hourly rsync (cerberus-replicate.timer) --> /home/cretan/cerberus-rollups/rollups.db
```

- **Rollups** (Cerberus): `rollups.py rollup` reads `net.db` read-only and
  maintains `rollups.db` — `roll_talkers`, `roll_dns`, `roll_tls`,
  `roll_health`, `roll_events`, `device_dir`. Grains: 1m (30d), 5m (90d),
  1h (365d). Idempotent via `_meta.last_1m_bucket`.
- **Replication**: `rollups.py export` produces a consistent single-file
  snapshot (sqlite backup) + sha256 sidecar. `cerberus-replicate.timer` on
  clawdnode rsyncs it hourly, verifies the checksum, and publishes atomically.
  The dashboard never depends on Cerberus being reachable.
- **Dashboard**: `network.py` (Flask blueprint) + `templates/network.html`
  render the Overview against the local replica. Zero LLM calls, zero external
  chart deps (hand-rolled SVG).

## Files

| Path | What |
|---|---|
| `rollups.py` | rollup/retention/export/status worker (deployed to `/opt/cerberus-net/`) |
| `schema.sql` | rollups.db schema (reference) |
| `network.py` | Flask blueprint (deployed to `tools/radar-dashboard/`) |
| `templates/network.html` | Overview page |
| `deploy/cerberus/` | systemd service + timer (rollup every 5 min) |
| `deploy/clawdnode/` | replicate script + service + timer (hourly pull) |

## Deployment

Cerberus (as root):
```bash
install -m 0755 rollups.py /opt/cerberus-net/rollups.py
install -m 0644 deploy/cerberus/cerberus-rollups.{service,timer} /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now cerberus-rollups.timer
```

clawdnode:
```bash
cp network.py templates/network.html /home/cretan/.openclaw/workspace/tools/radar-dashboard/
install -m 0644 deploy/clawdnode/cerberus-replicate.{service,timer} /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now cerberus-replicate.timer
```

## Honesty contract (enforced)

- Volume card is "completed-flow volume", never "current bandwidth".
- Replica older than 15 min -> page reports **paused** with "data as of ___".
- Range windows anchor to the last recorded bucket, so a paused sensor still
  shows its last N of data rather than an empty window.
- `kernel_drops` is labeled cumulative.

## Not yet built (D–F, per PRD)

Live per-device rates (sampler), device identity resolution beyond MAC/IP,
Suricata signature-alert investigation, packet/payload evidence, trends,
connectivity diagnostics, on-demand reports.
