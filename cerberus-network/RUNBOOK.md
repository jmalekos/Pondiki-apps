# Cerberus Network Intelligence — Operations Runbook

Local-first LAN intelligence. Sensor (Cerberus Pi 5 + SSD) collects; clawdnode
renders the `/network` page from a read-only replica. Zero LLM at runtime.

## Components

| Host | Unit | Cadence | What |
|---|---|---|---|
| Cerberus | `cerberus-rollups.timer` → `.service` | 5 min | `rollups.py rollup` (rollups + retention + findings) then `export` (snapshot + sha256) |
| clawdnode | `cerberus-replicate.timer` → `.service` | hourly | rsync snapshot + checksum verify + atomic publish to `/home/cretan/cerberus-rollups/rollups.db` |
| clawdnode | `radar-dashboard.service` | always | Flask ops console; `/network` reads the replica |

Replica path (clawdnode): `/home/cretan/cerberus-rollups/rollups.db` (+ `.sha256`, `.prev`).

## Data model (rollups.db)

`roll_talkers` (device·direction·grain) · `roll_flows` (device→dest·app_proto) ·
`roll_dns` · `roll_tls` · `roll_health` · `roll_probes` · `roll_events` ·
`findings` (deterministic) · `device_dir`.

Grains: 1m→30d, 5m→90d, 1h→365d (flows also 300). Findings recomputed each run
(idempotent) for a 30-day window; new_device uses a 24h window to avoid
initial-baseline flood.

## Capture resume (explicit step — NOT automatic)

Capture is paused. To resume, in order:
1. Confirm SSD mounted: `ssh cretan@cerberus 'df -h /srv/cerberus-data'`.
2. Preflight: `smartctl -H /dev/sda` (if available); confirm byte limits on all
   bulk writers are in place (tcpdump `-C 200 -W 10`; Suricata pcap rotation
   `maxsize 200M rotate 3`).
3. `ssh cretan@cerberus 'sudo systemctl start suricata cerberus-eve-shipper cerberus-netmetrics'`
4. Watch `/network` Health for ~24h; verify no SD-card fallback writes and no
   orphaned-inode recurrence (STORE-01/03).
Do not resume as a side effect of building.

## Backup / restore

- Replication retains the **previous** valid generation at `rollups.db.prev`.
- Rollback: `sudo systemctl stop cerberus-replicate.timer` then
  `mv rollups.db.prev rollups.db && sudo systemctl restart radar-dashboard.service`.
- Verify integrity anytime:
  `sha256sum -c <(awk '{print $1"  rollups.db"}' rollups.db.sha256)`
- Full rebuild (Cerberus): `rm rollups.db* && rollups.py rollup` — everything
  is re-derivable from `net.db` (the raw authority).

## Retention / capacity

Byte ceilings enforced on the SSD (PRD v2.2 §8). Watch at 70%, hard action at 85%.
Packet ring is the first thing to shrink if EVE volume trends up.

## Troubleshooting

| Symptom | Check |
|---|---|
| Page shows "paused" | Normal when capture off. Age > 15 min by design. |
| Page shows "unreachable" | Replica missing/stale. Check `cerberus-replicate.timer` last run + `ssh cretan@cerberus` reachability. |
| Empty windows while paused | Windows anchor to last bucket; if `net.db` has no data in range this is expected. |
| Checksum mismatch | Failed pull leaves the previous generation intact — investigate the Cerberus export. |

## Not yet built (gated)

Live per-device rates (Phase D sampler) · Suricata signature-alert investigation ·
packet/payload evidence service (investigator-gated, over Tailscale) · 
incident preservation. Packet evidence requires capture resume (§ above).
