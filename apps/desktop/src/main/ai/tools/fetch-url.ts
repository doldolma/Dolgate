import { convert } from "html-to-text";

import type { AiToolDef } from "../../../shared/ai";
import { t } from '../../i18n';

export const FETCH_URL_TOOL: AiToolDef = {
  name: "fetch_url",
  description:
    "Fetch an http(s) web page and return its readable text content (for docs, articles). " +
    "Use when you have a specific URL to read.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute http(s) URL to fetch." },
    },
    required: ["url"],
  },
};

const MAX_INPUT_BYTES = 2_000_000;
const MAX_OUTPUT_CHARS = 8_000;

export async function runFetchUrl(
  args: Record<string, unknown>,
  opts: { signal: AbortSignal },
): Promise<string> {
  const rawUrl = typeof args.url === "string" ? args.url.trim() : "";
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return t('fetchUrl.badUrl');
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return t('fetchUrl.schemeOnly');
  }

  let response: Response;
  try {
    response = await fetch(parsed.toString(), {
      signal: opts.signal,
      headers: { "user-agent": "Dolgate/1.0 (AI assistant)" },
    });
  } catch {
    return t('fetchUrl.networkFailed');
  }
  if (!response.ok) {
    return `error: HTTP ${response.status}.`;
  }

  const body = (await response.text()).slice(0, MAX_INPUT_BYTES);
  const contentType = response.headers.get("content-type") ?? "";
  const text = contentType.includes("html")
    ? convert(body, { wordwrap: false })
    : body;
  return text.trim().slice(0, MAX_OUTPUT_CHARS) || t('fetchUrl.emptyResponse');
}
