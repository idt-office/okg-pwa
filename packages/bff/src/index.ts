import { fileURLToPath } from "node:url";

import { serve } from "@hono/node-server";
import { loadConfig } from "@okg/core";
import { config as loadEnv } from "dotenv";

import { createApp } from "./app.js";

// .env im Repo-Wurzelverzeichnis oder im Arbeitsverzeichnis; der Key bleibt hier.
loadEnv({
  path: [process.cwd() + "/.env", fileURLToPath(new URL("../../../.env", import.meta.url))],
  quiet: true,
});

const cfg = loadConfig();
const port = Number.parseInt(process.env.PORT ?? "8787", 10);
const webDist = fileURLToPath(new URL("../../web/dist", import.meta.url));

const app = createApp({ cfg, webDist });

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`BFF läuft auf http://localhost:${info.port} (Modell: ${cfg.model})`);
});
