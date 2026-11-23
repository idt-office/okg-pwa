import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { loadConfig, runAgent, type ChatMessage, type ChatRequest } from "@okg/core";
import { config as loadEnv } from "dotenv";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";

// .env im Repo-Wurzelverzeichnis oder im Arbeitsverzeichnis; der Key bleibt hier.
loadEnv({
  path: [
    process.cwd() + "/.env",
    fileURLToPath(new URL("../../../.env", import.meta.url)),
  ],
  quiet: true,
});

const cfg = loadConfig();
const port = Number.parseInt(process.env.PORT ?? "8787", 10);
const webDist = fileURLToPath(new URL("../../web/dist", import.meta.url));

const messageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(6000),
});

const chatRequestSchema = z.object({
  messages: z.array(messageSchema).min(1).max(40),
  enrich: z.boolean().default(true),
  model: z
    .string()
    .regex(/^[a-z0-9._-]{3,64}$/i)
    .optional(),
});

const app = new Hono();

/** Einfaches Tropfenlimit pro IP: der Key darf nicht durch Drehen am Rad leerlaufen. */
const hits = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 15;
const RATE_WINDOW_MS = 60_000;

app.use("/api/*", async (c, next) => {
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || now > entry.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
  } else if (entry.count >= RATE_LIMIT) {
    return c.json({ error: "Zu viele Anfragen. Bitte eine Minute warten." }, 429);
  } else {
    entry.count += 1;
  }
  if (hits.size > 5000) hits.clear();
  await next();
});

/** CORS nur für die Entwicklung mit dem Vite-Dev-Server. */
app.use("/api/*", async (c, next) => {
  const origin = c.req.header("origin");
  if (origin && /^http:\/\/localhost(:\d+)?$/.test(origin)) {
    c.header("access-control-allow-origin", origin);
    c.header("access-control-allow-headers", "content-type");
    c.header("access-control-allow-methods", "GET,POST,OPTIONS");
  }
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  await next();
});

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    model: cfg.model,
    endpoint: cfg.baseURL,
    budgetMs: cfg.budgetMs,
    maxRounds: cfg.maxRounds,
  }),
);

let modelCache: { at: number; ids: string[] } | undefined;

app.get("/api/models", async (c) => {
  if (modelCache && Date.now() - modelCache.at < 60_000) {
    return c.json({ models: modelCache.ids });
  }
  try {
    const response = await fetch(`${cfg.baseURL.replace(/\/$/, "")}/models`, {
      headers: { authorization: `Bearer ${cfg.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return c.json({ models: [cfg.model] });
    const body = (await response.json()) as { data?: { id?: string }[] };
    const ids = (body.data ?? []).map((item) => item.id).filter((id): id is string => !!id);
    modelCache = { at: Date.now(), ids };
    return c.json({ models: ids });
  } catch {
    return c.json({ models: [cfg.model] });
  }
});

app.post("/api/chat", async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: "Body ist kein JSON." }, 400);
  }

  const parsed = chatRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return c.json({ error: `Ungültige Anfrage: ${issue?.path.join(".")} ${issue?.message}` }, 400);
  }

  const payload: ChatRequest = {
    messages: parsed.data.messages as ChatMessage[],
    enrich: parsed.data.enrich,
    model: parsed.data.model,
  };

  c.header("cache-control", "no-cache, no-transform");
  c.header("x-accel-buffering", "no");

  return streamSSE(c, async (stream) => {
    const abort = new AbortController();
    stream.onAbort(() => abort.abort());
    try {
      for await (const event of runAgent(payload, cfg, abort.signal)) {
        await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ type: "error", message }),
      });
    }
  });
});

app.use("/*", serveStatic({ root: webDist }));

app.notFound(async (c) => {
  if (c.req.path.startsWith("/api/")) return c.json({ error: "Unbekannter Endpunkt." }, 404);
  try {
    const html = await readFile(`${webDist}/index.html`, "utf8");
    return c.html(html);
  } catch {
    return c.text(
      "Das Frontend ist noch nicht gebaut. Führe `npm run build` aus, oder nutze `npm run dev`.",
      503,
    );
  }
});

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`BFF läuft auf http://localhost:${info.port} (Modell: ${cfg.model})`);
});
