# Petition of Felix pulse checker

A Cloudflare Worker that reads the public New Zealand Parliament petition API once per minute and stores every successful or failed pulse in D1.

The monitored petition is:

<https://petitions.parliament.nz/1f10c734-0815-4699-b710-08dec0efef41?lang=en>

## API

- `GET /` renders a transparent, browser-source-ready signature overlay. It refreshes from the Worker API every 15 seconds while the source pulse remains once per minute.
- Add `?demo` to the overlay URL to try the rolling counter with `+1`, `+10`, and `Reset` controls. Demo changes are local to that browser and do not affect petition data.
- `GET /api/current` returns the newest successful count and the outcome of the most recent pulse.
- `GET /api/history?limit=100` returns recent pulses, newest first. The limit is constrained to 1–1,440.
- `GET /health` returns `200` only when the latest pulse succeeded within the last three minutes.

All responses are public JSON with `Cache-Control: no-store`.

## Local development

```powershell
bun install
bun run cf-typegen
bun run db:migrate:local
bun run dev
```

With the development server running, trigger the scheduled handler at `http://localhost:8787/__scheduled`.

## Deployment

The D1 database is configured in `wrangler.jsonc` in Cloudflare's Oceania region. Apply migrations before deploying:

```powershell
bun run db:migrate:remote
bun run deploy
```

Cron changes can take several minutes to propagate across Cloudflare.
