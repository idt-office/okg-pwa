import { readFile } from "node:fs/promises";

import { serveStatic } from "@hono/node-server/serve-static";
import { getConnInfo } from "@hono/node-server/conninfo";
import { runAgent as defaultRunAgent } from "@okg/core";
import type { AgentConfig, AgentEvent, ChatMessage, ChatRequest } from "@okg/core";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";

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

export interface AppDeps {
  cfg: AgentConfig;
  /** Injizierbar, damit Tests ohne Netz laufen. */
  runAgent?: (
    request: ChatRequest,
    cfg: AgentConfig,
    signal?: AbortSignal,
  ) => AsyncGenerator<AgentEvent>;
  fetchModels?: (cfg: AgentConfig) => Promise<string[]>;
  webDist: string;
  rateLimit?: { requests: number; windowMs: number };
  trustProxy?: boolean;
}

const RATE_LIMIT = 15;
const RATE_WINDOW_MS = 60_000;

export function createApp(deps: AppDeps): Hono {
  const { cfg, webDist } = deps;
  const runAgent = deps.runAgent ?? defaultRunAgent;
  const trustProxy = deps.trustProxy ?? process.env.TRUST_PROXY === "1";
  const limit = deps.rateLimit ?? { requests: RATE_LIMIT, windowMs: RATE_WINDOW_MS };
  const app = new Hono();

  /** Tropfenlimit pro Client: der geteilte Gateway-Key darf nicht leerlaufen. */
  const hits = new Map<string, { count: number; resetAt: number }>();

  app.use("/api/*", async (c, next) => {
    if (c.req.method === "OPTIONS") {
      // Preflights zählen nicht gegen das Limit.
      await next();
      return;
    }
    const key = clientKey(c, trustProxy);
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now > entry.resetAt) {
      hits.set(key, { count: 1, resetAt: now + limit.windowMs });
    } else if (entry.count >= limit.requests) {
      return c.json({ error: "Zu viele Anfragen. Bitte eine Minute warten." }, 429);
    } else {
      entry.count += 1;
    }
    if (hits.size > 5000) {
      for (const [entryKey, value] of hits) {
        if (now > value.resetAt) hits.delete(entryKey);
      }
    }
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
    const fetchModels = deps.fetchModels ?? loadModelsFromGateway;
    try {
      const ids = await fetchModels(cfg);
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
      return c.json(
        { error: `Ungültige Anfrage: ${issue?.path.join(".")} ${issue?.message}` },
        400,
      );
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
    const path = c.req.path;
    if (path.startsWith("/api/")) return c.json({ error: "Unbekannter Endpunkt." }, 404);
    // Fehlende Assets bleiben 404; nur echte Navigationspfade bekommen die App.
    if (/\.[a-z0-9]{2,5}$/i.test(path)) return c.text("Nicht gefunden.", 404);
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

  return app;
}

async function loadModelsFromGateway(cfg: AgentConfig): Promise<string[]> {
  const response = await fetch(`${cfg.baseURL.replace(/\/$/, "")}/models`, {
    headers: { authorization: `Bearer ${cfg.apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return [cfg.model];
  const body = (await response.json()) as { data?: { id?: string }[] };
  const ids = (body.data ?? []).map((item) => item.id).filter((id): id is string => !!id);
  return ids.length > 0 ? ids : [cfg.model];
}

function clientKey(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "proxy";
  }
  try {
    // Ohne vertrauenswürdigen Proxy zählt die Socket-Adresse, nicht der Header.
    return getConnInfo(c).remote.address ?? "local";
  } catch {
    return "local";
  }
}
