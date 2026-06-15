import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchExternal } from "@/lib/net";

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  vi.restoreAllMocks();
});

/** Stub global.fetch to yield the given responses/errors in order (last repeats). */
function mockFetch(seq: (Response | Error)[]) {
  let i = 0;
  const fn = vi.fn(async () => {
    const item = seq[Math.min(i, seq.length - 1)];
    i++;
    if (item instanceof Error) throw item;
    return item;
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe("fetchExternal", () => {
  it("returns a success without retrying", async () => {
    const fn = mockFetch([new Response("ok", { status: 200 })]);
    const res = await fetchExternal("https://x.test/a", { retries: 2 });
    expect(res.status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry a non-retryable status (404)", async () => {
    const fn = mockFetch([new Response("nf", { status: 404 })]);
    const res = await fetchExternal("https://x.test/b", { retries: 2 });
    expect(res.status).toBe(404);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a transient 503 then returns the eventual success", async () => {
    const fn = mockFetch([new Response("", { status: 503 }), new Response("ok", { status: 200 })]);
    const res = await fetchExternal("https://x.test/c", { retries: 2 });
    expect(res.status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries a network error and throws after exhausting attempts", async () => {
    const fn = mockFetch([new Error("boom"), new Error("boom-2")]);
    await expect(fetchExternal("https://x.test/d", { retries: 1 })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(2); // 1 initial + 1 retry
  });
});
