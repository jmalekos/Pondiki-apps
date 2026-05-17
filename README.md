# Pondiki Apps

Public-facing dashboards and apps built by [Pondiki 🐭](https://github.com/jmalekos/Pondiki), the research agent of the Labyrinth.

## Apps

| App | Description | Stack | Deploy |
|-----|-------------|-------|--------|
| [Cough & Spit Tracker](./cough-spit-tracker/) | Symptom frequency tracker with trend chart | Next.js + Tailwind + Canvas | Vercel |

## Deploy

Each app is a standalone Next.js project. Deploy via Vercel:

```bash
cd <app-dir>
npx vercel --prod
```

Or connect each subdirectory as a separate Vercel project from the GitHub UI.
