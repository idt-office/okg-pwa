import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchJson } from "../src/http.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const ok = () =>
  new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("fetchJson", () => {
  it("wiederholt einen Netzwerkaussetzer einmal", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed");
      return ok();
    });
    await expect(fetchJson("https://example.invalid/a")).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it("wiederholt einen 502 einmal", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      return calls === 1 ? new Response("weg", { status: 502 }) : ok();
    });
    await expect(fetchJson("https://example.invalid/b")).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it("wiederholt einen fachlichen 404 nicht", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      return new Response("nein", { status: 404 });
    });
    await expect(fetchJson("https://example.invalid/c")).rejects.toThrow(/404/);
    expect(calls).toBe(1);
  });

  it("wiederholt einen Client-Abbruch nicht", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      throw new DOMException("aborted", "AbortError");
    });
    await expect(
      fetchJson("https://example.invalid/d", { signal: controller.signal }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
