import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { pinyin } from "pinyin-pro";
import * as z from "zod/v4";
import type { Env, SecretBinding, TrainQueryResult } from "./types";
import { parseTrainMarkdown } from "./parser";

const CACHE_TTL_SECONDS = 300;
const KEY_CURSOR_NAME = "firecrawl:key-cursor";
const FIRECRAWL_URL = "https://api.firecrawl.dev/v2/scrape";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function stationSlug(station: string): string {
  const normalized = station.trim();
  if (!normalized || normalized.length > 24) {
    throw new Error("INVALID_STATION: station must contain 1-24 characters");
  }

  // Qunar route slugs use concatenated pinyin for standard Chinese station names.
  const slug = pinyin(normalized, { toneType: "none", type: "array" })
    .join("")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

  if (!slug) throw new Error("INVALID_STATION: unable to convert station to route slug");
  return slug;
}

function buildQunarUrl(departure: string, arrival: string, date: string): string {
  const from = stationSlug(departure);
  const to = stationSlug(arrival);
  return `https://huoche.qunar.com/train/tickets/${from}-to-${to}/${date}`;
}

async function readKey(binding: SecretBinding | string | undefined): Promise<string> {
  const value = typeof binding === "string"
    ? binding.trim()
    : binding && typeof binding.get === "function"
      ? (await binding.get()).trim()
      : "";
  return value.toUpperCase() === "DISABLED" ? "" : value;
}

function keyBindings(env: Env): Array<SecretBinding | string | undefined> {
  return [
    env.FIRECRAWL_KEY_1,
    env.FIRECRAWL_KEY_2,
    env.FIRECRAWL_KEY_3,
    env.FIRECRAWL_KEY_4,
    env.FIRECRAWL_KEY_5,
    env.FIRECRAWL_KEY_6
  ];
}

async function getStartSlot(env: Env): Promise<number> {
  try {
    const value = await env.TRAIN_CACHE.get(KEY_CURSOR_NAME);
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 0 && parsed < 6 ? parsed : 0;
  } catch {
    return 0;
  }
}

async function fetchWithKeyFailover(url: string, env: Env): Promise<string> {
  const bindings = keyBindings(env);
  const startSlot = await getStartSlot(env);
  let configuredCount = 0;
  const unauthorizedSlots: number[] = [];

  for (let offset = 0; offset < bindings.length; offset++) {
    const slot = (startSlot + offset) % bindings.length;
    const apiKey = await readKey(bindings[slot]);
    if (!apiKey) continue;
    configuredCount++;

    const response = await fetch(FIRECRAWL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        url,
        formats: ["markdown"],
        onlyMainContent: true,
        maxAge: 0
      }),
      signal: AbortSignal.timeout(60_000)
    });

    if (response.status === 401) {
      unauthorizedSlots.push(slot + 1);
      continue;
    }

    if (!response.ok) {
      // Only 401 triggers key rotation. 403, 429, timeouts and 5xx are
      // surfaced as service errors rather than incorrectly burning other keys.
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`FIRECRAWL_HTTP_${response.status}: ${detail || "Firecrawl request failed"}`);
    }

    const payload = await response.json() as {
      success?: boolean;
      data?: { markdown?: string };
    };

    const markdown = payload.data?.markdown;
    if (!payload.success || typeof markdown !== "string" || markdown.length === 0) {
      throw new Error("FIRECRAWL_EMPTY_MARKDOWN: response did not contain Markdown");
    }

    // Remember the last successful slot so it is tried first next time.
    await env.TRAIN_CACHE.put(KEY_CURSOR_NAME, String(slot));
    return markdown;
  }

  if (configuredCount === 0) {
    throw new Error("FIRECRAWL_KEYS_NOT_CONFIGURED: add at least one of the five Firecrawl secrets");
  }

  throw new Error(
    `FIRECRAWL_ALL_KEYS_UNAUTHORIZED: all ${configuredCount} configured key(s) returned 401; slots=${unauthorizedSlots.join(",")}`
  );
}

async function queryTrains(
  departure: string,
  arrival: string,
  date: string,
  env: Env
): Promise<TrainQueryResult> {
  const departureSlug = stationSlug(departure);
  const arrivalSlug = stationSlug(arrival);
  const cacheKey = `train:v1:${departureSlug}:${arrivalSlug}:${date}`;
  const now = Date.now();

  const cached = await env.TRAIN_CACHE.get<{
    cached_at: number;
    result: TrainQueryResult;
  }>(cacheKey, "json");

  if (cached && now - cached.cached_at < CACHE_TTL_SECONDS * 1000) {
    return {
      ...cached.result,
      cache: {
        hit: true,
        age_seconds: Math.max(0, Math.floor((now - cached.cached_at) / 1000))
      }
    };
  }

  const url = buildQunarUrl(departure, arrival, date);
  const markdown = await fetchWithKeyFailover(url, env);
  const parsed = parseTrainMarkdown(markdown, date);

  if (parsed.parsed_count === 0) {
    throw new Error("TRAIN_PARSE_EMPTY: no direct trains could be parsed; page structure may have changed");
  }

  if (!parsed.is_complete) {
    throw new Error(
      `TRAIN_PARSE_INCOMPLETE: expected ${parsed.expected_count ?? "unknown"} trains, parsed ${parsed.parsed_count}; result was not cached`
    );
  }

  const fetchedAt = new Date().toISOString();
  const result: TrainQueryResult = {
    success: true,
    query: { departure, arrival, date },
    expected_count: parsed.expected_count,
    parsed_count: parsed.parsed_count,
    is_complete: parsed.is_complete,
    trains: parsed.trains,
    source: {
      provider: "qunar",
      url,
      fetched_at: fetchedAt
    },
    cache: { hit: false, age_seconds: 0 }
  };

  await env.TRAIN_CACHE.put(
    cacheKey,
    JSON.stringify({ cached_at: now, result }),
    { expirationTtl: CACHE_TTL_SECONDS }
  );

  return result;
}

function createMcpServer(env: Env): McpServer {
  const server = new McpServer({
    name: "train-ticket-mcp",
    version: "1.0.0"
  });

  server.registerTool(
    "search_train_tickets",
    {
      description: "查询指定日期中国火车直达车次。输入出发车站、到达车站和日期，返回车次、出发到达时间、运行时长、票价、席别和页面余票状态。数据来自去哪儿网页抓取，库存可能变化，不代表锁定或可保证购买。",
      inputSchema: z.object({
        departure: z.string().min(1).max(24).describe("出发车站，例如杭州东"),
        arrival: z.string().min(1).max(24).describe("到达车站，例如北京南"),
        date: z.string().describe("乘车日期，格式 YYYY-MM-DD")
      })
    },
    async ({ departure, arrival, date }) => {
      try {
        if (!isValidDate(date)) {
          throw new Error("INVALID_DATE: date must be a real calendar date in YYYY-MM-DD format");
        }
        if (departure.trim() === arrival.trim()) {
          throw new Error("INVALID_ROUTE: departure and arrival must be different stations");
        }

        const result = await queryTrains(departure.trim(), arrival.trim(), date, env);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }]
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ success: false, error: message }) }]
        };
      }
    }
  );

  return server;
}

function isAuthorized(request: Request, env: Env): boolean {
  if (!env.MCP_ACCESS_TOKEN) return false;
  return request.headers.get("Authorization") === `Bearer ${env.MCP_ACCESS_TOKEN}`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id"
        }
      });
    }

    if (url.pathname === "/health" && request.method === "GET") {
      return json({ ok: true, service: "train-ticket-mcp", version: "1.0.0" });
    }

    if (url.pathname !== "/mcp") {
      return json({ error: "Not found", mcp_endpoint: "/mcp" }, 404);
    }

    if (!isAuthorized(request, env)) {
      return json({ error: "Unauthorized" }, 401);
    }

    // The v2 SDK's web-standard handler is suitable for Cloudflare Workers.
    // Its default legacy mode also accepts stateless 2025-era MCP clients.
    const handler = createMcpHandler(() => createMcpServer(env));
    return handler.fetch(request);
  }
};
