# Cough & Spit Tracker

A private health tracker for logging cough and spit frequency. Built with Next.js + Tailwind CSS. Zero backend — all data stays in your browser's localStorage.

## Features

- **Radio selector** — pick Cough or Spit, then tap the big button
- **14-day bar chart** — visual trend of both metrics
- **Daily log** — history table sorted newest first
- **Auto day rollover** — resets at midnight, keeps all history
- **Keyboard shortcuts** — `1` = cough mode, `2` = spit mode, `Space/Enter` = tap
- **No server, no signup** — all data local to your browser

## Local Development

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Production Build

```bash
npm run build
npm start
```

## Deploy to Vercel

### Quick (CLI)

```bash
npm i -g vercel
vercel
vercel --prod
```

### From GitHub (recommended)

1. Push this repo to GitHub
2. Go to [vercel.com/new](https://vercel.com/new)
3. Import the repo
4. Vercel detects Next.js automatically — no config needed
5. Deploy → every push to `main` deploys to production, PR branches get preview URLs

No environment variables required for base functionality.

## Deployment Rules (Pondiki Standard)

| App type                          | Platform   |
|-----------------------------------|------------|
| Static / client-side (this app)   | Vercel     |
| Full-stack Next.js                | Vercel     |
| Long-running backend / worker     | Railway    |
| WebSocket server                  | Railway    |
| Scheduled cron jobs               | Railway    |
| Docker containers                 | Railway or Render |
| Private/internal only             | Local + Tailscale Serve or Cloudflare Tunnel |

## Tech Stack

- **Framework:** Next.js 16
- **Styling:** Tailwind CSS v4
- **Persistence:** localStorage (client-side)
- **Chart:** Canvas API (zero dependencies)
