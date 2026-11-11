import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { pinyin } from "pinyin-pro";
import * as z from "zod/v4";
import type { Env, TrainQueryResult } from "./types";
import { parseTrainMarkdown } from "./parser";
import { scrapeWithKeyFailover } from "./firecrawl";
import { isValidDate, queryFlights } from "./flights";

const CACHE_TTL_SECONDS = 300;
const VERSION = "1.1.0";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

function stationSlug(station: string): string {
  const normalized = station.trim();
  if (!normalized || normalized.length > 24) {
    throw new Error("INVALID_STATION: station must contain 1-24 characters");
  }
  const slug = pinyin(normalized, { toneType: "none", type: "array" })
    .join("").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!slug) throw new Error("INVALID_STATION: unable to convert station to route slug");
  return slug;
}

async function queryTrains(
  departure: string, arrival: string, date: string, env: Env
): Promise<TrainQueryResult> {
  const departureSlug = stationSlug(departure);
  const arrivalSlug = stationSlug(arrival);
  const cacheKey = `train:v1:${departureSlug}:${arrivalSlug}:${date}`;
  const now = Date.now();
  const cached = await env.TRAIN_CACHE.get<{
    cached_at: number; result: TrainQueryResult;
  }>(cacheKey, "json");
  if (cached && now - cached.cached_at < CACHE_TTL_SECONDS * 1000) {
    const { source: _source, ...rest } = cached.result as TrainQueryResult & { source?: unknown };
    return { ...rest, cache: {
      hit: true, age_seconds: Math.max(0, Math.floor((now - cached.cached_at) / 1000))
    } };
  }
  const url = `https://huoche.qunar.com/train/tickets/${departureSlug}-to-${arrivalSlug}/${date}`;
  const doc = await scrapeWithKeyFailover(url, env);
  if (typeof doc.markdown !== "string" || doc.markdown.length === 0) {
    throw new Error("FIRECRAWL_EMPTY_MARKDOWN");
  }
  const parsed = parseTrainMarkdown(doc.markdown, date);
  if (parsed.parsed_count === 0) {
    throw new Error("TRAIN_PARSE_EMPTY: no direct trains could be parsed; page structure may have changed");
  }
  if (!parsed.is_complete) {
    throw new Error(`TRAIN_PARSE_INCOMPLETE: expected ${parsed.expected_count ?? "unknown"} trains, parsed ${parsed.parsed_count}; result was not cached`);
  }
  const result: TrainQueryResult = {
    success: true, query: { departure, arrival, date },
    expected_count: parsed.expected_count, parsed_count: parsed.parsed_count,
    is_complete: parsed.is_complete, trains: parsed.trains,
    cache: { hit: false, age_seconds: 0 }
  };
  await env.TRAIN_CACHE.put(cacheKey, JSON.stringify({ cached_at: now, result }), {
    expirationTtl: CACHE_TTL_SECONDS
  });
  return result;
}

function createMcpServer(env: Env): McpServer {
  const server = new McpServer({ name: "train-ticket-mcp", version: VERSION });
  server.registerTool(
    "search_train_tickets",
    {
      description: "查询指定日期中国火车直达车次。输入出发车站、到达车站和日期，返回车次、出发到达时间、运行时长、票价、席别和页面余票状态。库存可能变化，不代表锁定或可保证购买。",
      inputSchema: z.object({
        departure: z.string().min(1).max(24).describe("出发车站，例如杭州东"),
        arrival: z.string().min(1).max(24).describe("到达车站，例如北京南"),
        date: z.string().describe("乘车日期，格式 YYYY-MM-DD")
      })
    },
    async ({ departure, arrival, date }) => {
      try {
        if (!isValidDate(date)) throw new Error("INVALID_DATE: date must be a real calendar date in YYYY-MM-DD format");
        if (departure.trim() === arrival.trim()) throw new Error("INVALID_ROUTE: departure and arrival must be different stations");
        const result = await queryTrains(departure.trim(), arrival.trim(), date, env);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
        return { isError: true, content: [{ type: "text", text: JSON.stringify({ success: false, error: message }) }] };
      }
    }
  );

  server.registerTool(
    "search_flight_tickets",
    {
      description: "查询国内单程机票主列表。仅输入三字母城市代码 from_code、to_code 和 YYYY-MM-DD 日期；如 HGH→BJS、SHA→BJS，不要输入中文城市名。返回航班号、起降日期时间、实际机场/航站楼、页面展示价、票价文案和机型。BJS/SHA 等城市查询可包含多个机场，须使用每条结果的实际机场。价格未核验含税、余票和可订性；不含中转及折叠共享航班。status=partial 时明确告知数据不完整；is_complete=null 表示未验证全部库存，不得声称是全部航班。",
      inputSchema: z.object({
        from_code: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).describe("出发城市三字码，例如 HGH（杭州）、SHA（上海）；不是中文城市名"),
        to_code: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).describe("到达城市三字码，例如 BJS（北京）；返回的实际机场可能不止一个"),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("出发日期，YYYY-MM-DD")
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true }
    },
    async ({ from_code, to_code, date }) => {
      try {
        const result = await queryFlights({ from_code, to_code, date }, env);
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: { ...result } };
      } catch (error) {
        const message = error instanceof Error ? error.message : "FLIGHT_QUERY_FAILED";
        return { isError: true, content: [{ type: "text", text: JSON.stringify({ success: false, error: message }) }] };
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
      return json({ ok: true, service: "train-ticket-mcp", version: VERSION });
    }
    if (url.pathname !== "/mcp") return json({ error: "Not found", mcp_endpoint: "/mcp" }, 404);
    if (!isAuthorized(request, env)) return json({ error: "Unauthorized" }, 401);
    const handler = createMcpHandler(() => createMcpServer(env));
    return handler.fetch(request);
  }
};
