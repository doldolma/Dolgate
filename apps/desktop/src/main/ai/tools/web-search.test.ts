import { afterEach, describe, expect, it, vi } from "vitest";
import { runWebSearch } from "./web-search";

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe("runWebSearch (Tavily)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns an error when the Tavily key is missing", async () => {
    const result = await runWebSearch(
      { query: "x" },
      { signal: signal(), backend: "tavily", apiKey: null },
    );
    expect(result).toContain("Tavily API 키");
  });

  it("returns an error on an empty query", async () => {
    const result = await runWebSearch(
      { query: "   " },
      { signal: signal(), backend: "tavily", apiKey: "k" },
    );
    expect(result).toContain("검색어");
  });

  it("formats the Tavily answer and results", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          answer: "42",
          results: [{ title: "Guide", url: "https://a.example", content: "body text" }],
        }),
        { status: 200 },
      ),
    );
    const result = await runWebSearch(
      { query: "meaning" },
      { signal: signal(), backend: "tavily", apiKey: "k" },
    );
    expect(result).toContain("Answer: 42");
    expect(result).toContain("Guide — https://a.example");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.tavily.com/search",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("returns an error on a non-ok response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 401 }));
    const result = await runWebSearch(
      { query: "x" },
      { signal: signal(), backend: "tavily", apiKey: "bad" },
    );
    expect(result).toContain("HTTP 401");
  });

  it("redacts secret-looking tokens from the query", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ results: [] }), { status: 200 }));
    await runWebSearch(
      { query: "why is sk-abcdef1234567 leaking" },
      { signal: signal(), backend: "tavily", apiKey: "k" },
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.query).not.toContain("abcdef1234567");
  });
});

describe("runWebSearch (DuckDuckGo, keyless)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("scrapes DuckDuckGo HTML without a key", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          '<div class="result"><a class="result__a">Nginx docs</a><div class="result__snippet">config guide</div></div>',
          { status: 200 },
        ),
      );
    const result = await runWebSearch(
      { query: "nginx config" },
      { signal: signal(), backend: "duckduckgo", apiKey: null },
    );
    expect(result).toContain("Nginx docs");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://html.duckduckgo.com/html/",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("returns an error on a non-ok DDG response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 403 }));
    const result = await runWebSearch(
      { query: "x" },
      { signal: signal(), backend: "duckduckgo", apiKey: null },
    );
    expect(result).toContain("HTTP 403");
  });
});
