# API (`Server` workspace)

Node + [Hono](https://hono.dev) API for the salon POS (sales, commissions, payouts, reports), deployed on **Render**. It owns **all** business rules, auth and database access (Neon Postgres via Drizzle). The web app in `../Client` is its only caller.

## How it is called

`POST /rpc/<action>` with `Authorization: Bearer <API_KEY>` and a JSON body

```json
{ "args": [ ... ], "cookies": { "name": "value" }, "headers": { "x-real-ip": "..." } }
```

It answers `{ "result": ..., "setCookies": [ { "name", "value", "options" } ] }`. `GET /health` is public. Everything else is 404. The callable actions are listed in `src/http/registry.ts`.

The client IP (login rate limit) is taken from the body, so requests without the exact key get 401 before anything is parsed.

## Layout

| Path | What |
|---|---|
| `src/http/` | Hono app (`app.ts`), allowed actions (`registry.ts`) |
| `src/actions/` | one function per action: auth check, zod validation, business function |
| `src/server/` | business logic (sales, catalog, payouts, backup, reports SQL) |
| `src/lib/` | pure helpers (money, time, report oracle, auth, rate limit, schemas) |
| `src/db/` | Drizzle schema, migrations (commit them, never edit an applied one), seed |

`src/lib/{auth-core,backdate,messages,money,reports,route-guard,sale-rules,time,types}.ts` are copied into the web app. **Change them here**, then run `npm run sync:shared` at the root.

## Run and deploy

Run commands from the repository root (see the root README). Local environment: copy `.env.example` to `.env`. Tests use in-memory Postgres and touch no real database.

Deployment (Render, root `render.yaml`): see [`../docs/DEPLOY.md`](../docs/DEPLOY.md).
