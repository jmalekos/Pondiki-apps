# ARCHIVED — superseded

This Next.js alerts-only MVP is **archived** (2026-10-27). It is replaced by the
local-first `/network` page in the ops console — see `../cerberus-network/`.

- The web app only surfaced a thin alerts view that depended on Supabase.
- The collector (`collector/`) and shipper (`ingest/`) code remain the live
  ingestion pipeline deployed to Cerberus (`/opt/cerberus-net/` and
  `/opt/cerberus-dashboard/ingest/`) — they are **not** part of this archive.
- Supabase `alerts` forwarding is retired pending a Phase A consumer inventory;
  the shipper runs local-only.

Do not build on top of `web/`. Direct new work to `cerberus-network/`.
