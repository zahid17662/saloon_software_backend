// API entrypoint (Render runs `npm start`). Fails fast on missing configuration, so a bad deploy
// never starts serving half-configured.

import { serve } from "@hono/node-server";
import { createApp } from "./http/app";

for (const name of ["DATABASE_URL", "SESSION_SECRET", "API_KEY"]) {
  if (!process.env[name]) {
    console.error(`${name} must be set`);
    process.exit(1);
  }
}
if ((process.env.API_KEY as string).length < 32) {
  console.error("API_KEY must be at least 32 characters");
  process.exit(1);
}

const port = Number(process.env.PORT ?? 4000);
const server = serve({ fetch: createApp().fetch, port, hostname: "0.0.0.0" }, (info) => {
  console.log(`salon API listening on :${info.port}`);
});

const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
