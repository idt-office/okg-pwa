import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentConfig, AgentEvent, ChatRequest } from "@okg/core";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";

const cfg: AgentConfig = {
  baseURL: "http://example.invalid/v1",
  apiKey: "geheim-123",
  model: "test-model",
  maxRounds: 4,
  budgetMs: 1000,
  finalAnswerMs: 1000,
};

async function webRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "okg-web-"));
  await writeFile(join(dir, "index.html"), "<!doctype html><title>OKG</title>");
  await mkdir(join(dir, "assets"));
  await writeFile(join(dir, "assets", "app.js"), "console.log(1)");
  return dir;
}

async function* fakeAgent(request: ChatRequest): AsyncGenerator<AgentEvent> {
  yield { type: "token", text: `gesehen: ${request.messages.at(-1)?.content}` };
  yield {
    type: "done",
    model: cfg.model,
    rounds: 1,
    elapsedMs: 5,
    truncated: false,
    enrich: request.enrich,
  };
}

function body(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    messages: [{ role: "user", content: "Wie viele?" }],
    enrich: true,
    ...overrides,
  });
}

describe("API", () => {
  it("liefert Health ohne Secrets", async () => {
    const app = createApp({ cfg, webDist: await webRoot(), runAgent: fakeAgent });
    const response = await app.request("/api/health");
    expect(response.status).toBe(200);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json.model).toBe("test-model");
    expect(JSON.stringify(json)).not.toContain("geheim-123");
  });

  it("weist einen kaputten Body mit 400 ab", async () => {
    const app = createApp({ cfg, webDist: await webRoot(), runAgent: fakeAgent });
    const broken = await app.request("/api/chat", { method: "POST", body: "kein json" });
    expect(broken.status).toBe(400);

    const empty = await app.request("/api/chat", { method: "POST", body: body({ messages: [] }) });
    expect(empty.status).toBe(400);
  });

  it("streamt Ereignisse als Server-Sent Events", async () => {
    const app = createApp({ cfg, webDist: await webRoot(), runAgent: fakeAgent });
    const response = await app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body(),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const text = await response.text();
    expect(text).toContain("event: token");
    expect(text).toContain("gesehen: Wie viele?");
    expect(text).toContain("event: done");
  });

  it("meldet einen Fehler im Agenten als error-Ereignis", async () => {
    async function* failing(): AsyncGenerator<AgentEvent> {
      yield { type: "token", text: "Anfang" };
      throw new Error("Modell weg");
    }
    const app = createApp({ cfg, webDist: await webRoot(), runAgent: failing });
    const response = await app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body(),
    });
    const text = await response.text();
    expect(text).toContain("event: token");
    expect(text).toContain("event: error");
    expect(text).toContain("Modell weg");
  });

  it("drosselt nach dem konfigurierten Limit", async () => {
    const app = createApp({
      cfg,
      webDist: await webRoot(),
      runAgent: fakeAgent,
      rateLimit: { requests: 2, windowMs: 60_000 },
    });
    for (let index = 0; index < 2; index += 1) {
      const ok = await app.request("/api/chat", { method: "POST", body: body() });
      await ok.text();
      expect(ok.status).toBe(200);
    }
    const throttled = await app.request("/api/chat", { method: "POST", body: body() });
    expect(throttled.status).toBe(429);
  });

  it("nimmt die Modellliste aus dem Gateway oder den Standard", async () => {
    const withList = createApp({
      cfg,
      webDist: await webRoot(),
      runAgent: fakeAgent,
      fetchModels: async () => ["a", "b"],
    });
    expect(await (await withList.request("/api/models")).json()).toEqual({ models: ["a", "b"] });

    const withoutList = createApp({
      cfg,
      webDist: await webRoot(),
      runAgent: fakeAgent,
      fetchModels: async () => {
        throw new Error("Gateway weg");
      },
    });
    expect(await (await withoutList.request("/api/models")).json()).toEqual({
      models: ["test-model"],
    });
  });
});

describe("statische Auslieferung", () => {
  it("liefert die App für Navigationspfade", async () => {
    const app = createApp({ cfg, webDist: await webRoot(), runAgent: fakeAgent });
    const response = await app.request("/irgendein/pfad");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("OKG");
  });

  it("liefert vorhandene Assets", async () => {
    const app = createApp({ cfg, webDist: await webRoot(), runAgent: fakeAgent });
    const response = await app.request("/assets/app.js");
    expect(response.status).toBe(200);
  });

  it("gibt für fehlende Assets 404 statt index.html", async () => {
    const app = createApp({ cfg, webDist: await webRoot(), runAgent: fakeAgent });
    const response = await app.request("/assets/fehlt.js");
    expect(response.status).toBe(404);
  });

  it("meldet einen unbekannten API-Pfad als 404", async () => {
    const app = createApp({ cfg, webDist: await webRoot(), runAgent: fakeAgent });
    const response = await app.request("/api/gibtsnicht");
    expect(response.status).toBe(404);
  });

  it("weist Anfragen ohne gebautes Frontend mit 503 ab", async () => {
    const app = createApp({ cfg, webDist: "/tmp/gibt-es-nicht-okg", runAgent: fakeAgent });
    const response = await app.request("/");
    expect(response.status).toBe(503);
  });
});

describe("CORS", () => {
  it("erlaubt nur lokale Origins", async () => {
    const app = createApp({ cfg, webDist: await webRoot(), runAgent: fakeAgent });
    const local = await app.request("/api/health", { headers: { origin: "http://localhost:5173" } });
    expect(local.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");

    const fremd = await app.request("/api/health", { headers: { origin: "https://boese.example" } });
    expect(fremd.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("beantwortet den Preflight mit 204", async () => {
    const app = createApp({ cfg, webDist: await webRoot(), runAgent: fakeAgent });
    const response = await app.request("/api/chat", { method: "OPTIONS" });
    expect(response.status).toBe(204);
  });
});
