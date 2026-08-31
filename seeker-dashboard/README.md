# Seeker Dashboard

Solana portfolio dashboard for the seeker wallet (`CKnkuC4jhtKq1DGiXcGztxSsRsUNVBF44zQFqkaMYwg8`).

**Stack:** Next.js 16 (App Router) · TypeScript · Tailwind v4 · zero API keys

## Data layer

| Source | Use |
|---|---|
| `api.mainnet-beta.solana.com` (public RPC) | SOL balance, SPL + Token-2022 token accounts |
| DexScreener `latest/dex/tokens/{mint}` | Price, 24h change, liquidity, volume, symbol/name |
| Jupiter `swap/v1/quote` | Fallback pricing for tokens without DexScreener pairs |

In-process cache (60s TTL) + 300ms pacing between external calls. Auto-refresh every 60s on the client.

## Run

```bash
npm run dev        # dev on :3000
npm run build && PORT=3030 npm start   # prod
```

## systemd (persistent)

```bash
systemctl --user enable --now seeker-dashboard
# unit: ~/.config/systemd/user/seeker-dashboard.service
```

Served at `http://clawdnode:3030` (Tailscale) / `http://<pi-ip>:3030`.

## API

`GET /api/portfolio` → `{ wallet, totalUsd, solBalance, weightedChange24h, holdings[], unpricedCount }`
`GET /api/portfolio?force=1` → bypass cache

## Status

- [x] Portfolio v1 (balances, prices, allocation, 24h, unpriced flags)
- [ ] Strategy tracking (seeker strategy KPIs, entries/exits)
- [ ] History / PnL over time
- [ ] Alerts (Telegram)
