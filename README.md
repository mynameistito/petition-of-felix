# Petition of Felix live overlay

A transparent, live-updating signature counter for the New Zealand Parliament petition **[Petition of Felix](https://petitions.parliament.nz/1f10c734-0815-4699-b710-08dec0efef41?lang=en)**. It runs on Cloudflare Workers and is designed to be added to OBS as a browser source.

## Use the overlay

Open the deployed Worker URL in a browser, or add it to OBS as a **Browser Source**. The page has a transparent background and displays the latest signature count. Live updates are sent over a WebSocket; the browser reconnects automatically if its connection is interrupted.

To preview the counter without changing petition data, append `?demo` to the Worker URL. Demo controls let you add 100, add 1,000, choose a custom positive whole-number increment, or reset the demo counter. Demo changes sync between browsers and are kept separate from the petition count.

## Run locally

Prerequisites: [Bun](https://bun.sh/) and a Cloudflare account for deployment.

```powershell
bun install
bun run cf-typegen
bun run db:migrate:local
bun run dev
```

Open <http://localhost:8787/> to view the overlay. Open <http://localhost:8787/?demo> in multiple tabs to try the synchronized demo. Wrangler runs the Worker and its SQLite-backed Durable Objects locally. To trigger the scheduled five-minute heartbeat manually, visit <http://localhost:8787/__scheduled>.

Run the project checks:

```powershell
bun run typecheck
bun run test
bun run check
```

## HTTP endpoints

| Path | Description |
| --- | --- |
| `GET /` | Transparent signature-count overlay. Add `?demo` for the isolated demo counter. |
| `GET /ws` | WebSocket for live petition updates. |
| `GET /demo-ws` | WebSocket used by the demo counter. |
| `GET /api/current` | Latest successful count and most recent check result. |
| `GET /api/history?limit=100` | Recent recorded checks, newest first. `limit` must be from 1 to 1,440. |
| `GET /health` | Returns `200` when the latest check succeeded within eight minutes; otherwise `503`. |

API responses are public and sent with `Cache-Control: no-store`.

## How it works

- One SQLite-backed Durable Object coordinates live petition updates for all connected browsers. Browsers do not poll Parliament individually.
- While viewers are connected, the coordinator checks the Parliament petition API every two seconds. It stops polling when the last viewer disconnects; a five-minute scheduled check keeps the history and health status current while idle.
- D1 stores changed signature counts and scheduled heartbeat checks. Repeated unchanged samples are not stored, and a failed check does not replace the last valid count.
- A separate Durable Object handles demo state. It has no access to petition polling or D1.
- WebSocket connections use Durable Object hibernation. On reconnect, the overlay resynchronizes with the latest persisted count.

## Deploy

The D1 database, Durable Object bindings, and migrations are configured in `wrangler.jsonc`. Apply the D1 migrations and deploy the Worker:

```powershell
bun run db:migrate:remote
bun run deploy
```

Cron schedule changes can take several minutes to propagate across Cloudflare.

## License

This project is open source under the [MIT License](LICENSE).
