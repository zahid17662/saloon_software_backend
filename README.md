# Salon POS: backend API

Node + [Hono](https://hono.dev) API for the salon POS (sales, commissions, payouts, reports). It owns
**all** business rules, auth and database access (Neon Postgres via Drizzle). The web app lives in the
frontend repo (`saloon_software_frontend`, deployed on Vercel) and is the only caller.

Deployed on **Render**. The business rules (integer-taka money, commission snapshots, voids, Asia/Dhaka
days, idempotency keys) are unchanged; see the PRD in the dev meta-repo.

## How it is called

`POST /rpc/<action>` with `Authorization: Bearer <API_KEY>` and a JSON body

```json
{ "args": [ ... ], "cookies": { "name": "value" }, "headers": { "x-real-ip": "..." } }
```

It answers `{ "result": ..., "setCookies": [ { "name", "value", "options" } ] }`. The web app forwards the
visitor's session cookies and IP inside the body and applies the returned `setCookies` in the browser.
`GET /health` is public. Everything else is 404. The list of callable actions is `src/http/registry.ts`.

Why the key matters: the client IP (login rate limit) is taken from the body, so without the key anyone
could pretend to be any IP. Requests without the exact key get 401, before anything is parsed.

## Layout

| Path | What |
|---|---|
| `src/http/` | Hono app (`app.ts`), allowed-actions list (`registry.ts`) |
| `src/actions/` | one function per API action: auth check, zod validation, then the business function |
| `src/server/` | the business logic (sales, catalog, payouts, backup, reports SQL) |
| `src/lib/` | pure helpers (money, time, reports oracle, auth cookies, rate limit, schemas) |
| `src/db/` | Drizzle schema, migrations (`src/db/migrations`, commit them, never edit an applied one), seed |

`src/lib/{auth-core,backdate,messages,money,reports,route-guard,sale-rules,time,types}.ts` are also
copied into the frontend repo (`src/shared/lib`). **Change them here first**, then re-sync the frontend.

## Run locally

```bash
cp .env.example .env     # fill in DATABASE_URL, DIRECT_URL, SESSION_SECRET, API_KEY
npm install
npm run db:migrate
npm run db:seed          # first time only
npm run dev              # http://localhost:4000
npm test                 # in-memory Postgres (PGlite), no real database touched
npm run typecheck
```

## Deploy on Render

1. Render dashboard: **New, Blueprint**, pick this repo. `render.yaml` defines the `salon-api` web service.
2. When asked, fill in the four secrets (they are `sync: false`, so they are never in git):

| Variable | Value |
|---|---|
| `DATABASE_URL` | Neon **pooled** connection string |
| `DIRECT_URL` | Neon **direct** (no `-pooler`) string. Used only by the migration step in the build |
| `SESSION_SECRET` | the **same** value as on the Vercel project |
| `API_KEY` | the **same** value as on the Vercel project (at least 32 characters) |

3. The build runs `npm ci --include=dev && npm run db:migrate`, so pending migrations are applied before
   the new version starts. If a migration fails, the deploy fails and the old version keeps serving.
4. Health check path is `/health`. The API URL (`https://<name>.onrender.com`) goes into the Vercel
   project as `API_URL`.

`plan: free` sleeps after 15 minutes without traffic, and the next request waits about a minute while it
wakes. For a shop that is open all day, switch the service to the `starter` plan.
