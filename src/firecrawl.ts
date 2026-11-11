import type { Env, SecretBinding } from "./types";

export interface ScrapeDocument {
  markdown?: string;
  metadata?: { url?: string; sourceURL?: string; statusCode?: number; scrapeId?: string };
  actions?: { javascriptReturns?: Array<{ type?: string; value: unknown }> };
  warning?: string;
}
export interface ScrapeOptions {
  mobile?: boolean;
  onlyMainContent?: boolean;
  waitFor?: number;
  timeout?: number;
  actions?: Array<{ type: "executeJavascript"; script: string }>;
}
const KEY_CURSOR = "firecrawl:key-cursor";
const ENDPOINT = "https://api.firecrawl.dev/v2/scrape";

/** Shared by both tools. Only an upstream API HTTP 401 rotates a key. */
export async function scrapeWithKeyFailover(
  url: string, env: Env, options: ScrapeOptions = {}
): Promise<ScrapeDocument> {
  const bindings: Array<SecretBinding | string | undefined> = [
    env.FIRECRAWL_KEY_1, env.FIRECRAWL_KEY_2, env.FIRECRAWL_KEY_3,
    env.FIRECRAWL_KEY_4, env.FIRECRAWL_KEY_5, env.FIRECRAWL_KEY_6
  ];
  let start = 0;
  try {
    const raw = await env.TRAIN_CACHE.get(KEY_CURSOR);
    const value = raw === null ? 0 : Number(raw);
    if (Number.isInteger(value) && value >= 0 && value < bindings.length) start = value;
  } catch { /* Cursor is advisory, not an availability dependency. */ }

  const timeout = Math.min(70_000, Math.max(1000, options.timeout ?? 55_000));
  const deadline = Date.now() + timeout + 5000;
  let configured = 0;
  let unreadable = 0;
  for (let offset = 0; offset < bindings.length; offset++) {
    const slot = (start + offset) % bindings.length;
    let key = "";
    try {
      const binding = bindings[slot];
      key = (typeof binding === "string" ? binding : await binding?.get() ?? "").trim();
    } catch { unreadable++; continue; }
    if (!key || key.toUpperCase() === "DISABLED") continue;
    configured++;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("FIRECRAWL_TIMEOUT");
    let response: Response;
    try {
      response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          onlyMainContent: true, ...options, timeout,
          url, formats: ["markdown"], maxAge: 0
        }),
        signal: AbortSignal.timeout(remaining)
      });
    } catch (error) {
      // Never propagate fetch errors that may contain request headers or credentials.
      const name = error instanceof Error ? error.name : "";
      throw new Error(name === "TimeoutError" || name === "AbortError"
        ? "FIRECRAWL_TIMEOUT" : "FIRECRAWL_NETWORK_ERROR");
    }
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      // Do not rotate on exhausted credit (402), permissions (403), rate limits (429), or 5xx.
      throw new Error(`FIRECRAWL_HTTP_${response.status}`);
    }
    let payload: { success?: boolean; data?: ScrapeDocument };
    try { payload = await response.json() as typeof payload; }
    catch { throw new Error("FIRECRAWL_INVALID_JSON"); }
    if (!payload.success || !payload.data || typeof payload.data !== "object") {
      throw new Error("FIRECRAWL_INVALID_RESPONSE");
    }
    // Avoid writing the same global KV key on every successful query.
    if (slot !== start) {
      try { await env.TRAIN_CACHE.put(KEY_CURSOR, String(slot)); }
      catch { /* KV eventual consistency / write throttling must not lose a successful scrape. */ }
    }
    return payload.data;
  }
  if (configured === 0) {
    throw new Error(unreadable ? "FIRECRAWL_SECRET_READ_FAILED" : "FIRECRAWL_KEYS_NOT_CONFIGURED");
  }
  throw new Error("FIRECRAWL_ALL_KEYS_UNAUTHORIZED");
}
