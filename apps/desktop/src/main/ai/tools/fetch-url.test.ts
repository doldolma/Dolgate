import { afterEach, describe, expect, it, vi } from "vitest";
import { runFetchUrl } from "./fetch-url";

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe("runFetchUrl", () => {
  afterEach(() => vi.restoreAllMocks());

  it("rejects non-http(s) URLs", async () => {
    const result = await runFetchUrl({ url: "ftp://x/y" }, { signal: signal() });
    expect(result).toContain("http/https");
  });

  it("rejects malformed URLs", async () => {
    const result = await runFetchUrl({ url: "not a url" }, { signal: signal() });
    expect(result).toContain("잘못된 URL");
  });

  it("extracts readable text from HTML and skips scripts", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        "<html><body><h1>Title</h1><p>Hello world</p><script>leak()</script></body></html>",
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
      ),
    );
    const result = await runFetchUrl({ url: "https://example.com" }, { signal: signal() });
    expect(result).toContain("Hello world");
    expect(result).not.toContain("leak()");
  });

  it("returns an error on an http failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 404 }));
    const result = await runFetchUrl({ url: "https://example.com" }, { signal: signal() });
    expect(result).toContain("HTTP 404");
  });
});
