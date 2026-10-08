# Petition of Felix live overlay

A Cloudflare Worker that reads the public New Zealand Parliament petition API and serves a transparent OBS/browser-source overlay. One SQLite-backed Durable Object coordinates all live clients for this petition.

The monitored petition is:

<https://petitions.parliament.nz/1f10c734-0815-4699-b710-08dec0efef41?lang=en>

## API

- `GET /` renders a transparent, browser-source-ready signature overlay. It receives live updates over a WebSocket and reconnects with bounded exponential backoff.
- `GET /ws` upgrades to the petition's shared WebSocket coordinator. A new connection receives the latest persisted count immediately, then receives only changed authoritative counts.
- Add `?demo` to the overlay URL to try the rolling counter with `+100`, `+1000`, a custom positive whole-number increment, and `Reset`. The demo also shows the latest recorded live petition count as a read-only reference. Demo actions sync across browsers using a separate demo-only Durable Object and never change petition state or D1 data.
- `GET /api/current` returns the newest successful count and the outcome of the most recent persisted check. It remains available as an HTTP fallback/debug endpoint.
- `GET /api/history?limit=100` returns recent pulses, newest first. The limit is constrained to 1–1,440.
- `GET /health` returns `200` only when the latest check succeeded within eight minutes.

## Realtime and persistence

- All `/ws` connections route to one stable Durable Object named `felix-petition`; connected browsers never poll Parliament themselves.
- While at least one WebSocket is connected, the Durable Object uses alarms to poll the Parliament JSON API every two seconds. It does not start one loop per viewer, avoids overlapping local polls, and cancels its alarm after the last client disconnects.
- When idle, aggressive polling stops. The existing five-minute Cron invokes the same coordinator for a low-frequency health/history heartbeat.
- D1 records count changes and successful five-minute heartbeats. Repeated two-second samples with an unchanged count do not create rows. Failures are coalesced to a changed error or one record per five-minute interval; the last valid count stays available.
- WebSockets use Durable Object hibernation. The browser retains its last valid count during short reconnects, requests a resync on reconnect/visibility restoration, and never displays a fabricated count jump.
- Demo browsers use a second hibernating Durable Object with its own counter and no alarm, D1 binding, or Parliament fetch path.
- Both Durable Object bindings and their SQLite class migrations are declared in `wrangler.jsonc`.

API responses are public and use `Cache-Control: no-store`.

## Local development

```powershell
bun install
bun run cf-typegen
bun run db:migrate:local
bun run dev
```

Use `http://localhost:8787/` as the overlay. Wrangler runs both SQLite-backed Durable Objects locally; open multiple `?demo` tabs to see the demo counter sync between them. To exercise the five-minute idle heartbeat manually, trigger the scheduled handler at `http://localhost:8787/__scheduled`.

Run tests and checks with `bun run typecheck`, `bun run test`, and `bun run check`.

## Deployment

The D1 database and Durable Object are configured in `wrangler.jsonc`. Apply D1 migrations and deploy:

```powershell
bun run db:migrate:remote
bun run deploy
```

Cron changes can take several minutes to propagate across Cloudflare.
