import type { Env } from "./types";
import { scrapeWithKeyFailover, type ScrapeDocument } from "./firecrawl";
import { FLIGHT_OBSERVATION_SCRIPT } from "./flight-browser";

export interface FlightQuery { from_code: string; to_code: string; date: string; }
export interface Flight {
  flight_number: string; airline: string;
  departure_date: string; departure_time: string;
  departure_airport: string; departure_terminal: string | null;
  arrival_date: string | null; arrival_time: string;
  arrival_airport: string; arrival_terminal: string | null;
  arrival_date_source: "page_label" | "same_day_default" | "unknown";
  display_price: number; currency: "CNY"; price_text: string;
  fare_text: string | null; aircraft: string | null;
  has_codeshare_options: boolean;
  tags: string[];
  remaining_seats: null; tax_included: null;
}
export interface FlightObservation {
  kind: "tongcheng-flight-observation-v1"; url: string; selected_date: string;
  initial_count: number; counts: number[]; rounds: number;
  at_bottom: boolean; loading: boolean; stable_rounds: number;
  stable: boolean; truncated: boolean; cards: string[];
}
export interface FlightResult {
  success: true; status: "ok" | "partial"; query: FlightQuery;
  expected_count: null; parsed_count: number;
  // The provider does not publish an authoritative total. Never claim total inventory completeness.
  is_complete: null;
  flights: Flight[];
  coverage: {
    scope: "visible_main_listing";
    observed_count: number; parsed_count: number; rejected_count: number;
    duplicate_count: number; initial_count: number; scroll_rounds: number;
    observed_list_stable: boolean; selected_date_matches: boolean | null;
    all_observed_cards_parsed: boolean; all_inventory_verified: false;
  };
  warnings: string[];
  source: { provider: "tongcheng"; url: string; fetched_at: string; page_updated_at: null };
  cache: { hit: boolean; age_seconds: number; ttl_seconds: number };
}
const TTL = 300;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const PRICE = /^[¥￥]\s*(\d+(?:,\d{3})*(?:\.\d{1,2})?)(?:起)?$/;
const FLIGHT_LINE = /^(.+?)\s+([A-Z0-9]{2}\d{3,4}[A-Z]?)$/;

export function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
export function validateFlightQuery(input: FlightQuery): FlightQuery {
  const from = input.from_code.trim().toUpperCase(), to = input.to_code.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) {
    throw new Error("INVALID_CITY_CODE: use three-letter city codes, e.g. HGH, BJS, SHA; not city names");
  }
  if (from === to) throw new Error("INVALID_ROUTE: city codes must differ");
  if (!isValidDate(input.date)) throw new Error("INVALID_DATE: use a real YYYY-MM-DD date");
  return { from_code: from, to_code: to, date: input.date };
}
export function buildTongchengUrl(input: FlightQuery): string {
  const q = validateFlightQuery(input);
  const params = new URLSearchParams({ fromCode: q.from_code, toCode: q.to_code, date: q.date });
  return `https://m.ly.com/ft/touch/book1?${params}`;
}
function airport(label: string): { name: string; terminal: string | null } {
  const m = label.match(/^(.*?)(T\d+[A-Z]?)$/i);
  return { name: (m ? m[1] : label).trim(), terminal: m ? m[2].toUpperCase() : null };
}
function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
function arrivalDate(label: string | undefined, date: string, departure: string, arrival: string) {
  if (label) {
    const monthDay = label.match(/^(\d{1,2})月(\d{1,2})日/);
    if (monthDay) {
      // Resolve year rollover using the departure date, not the scraping server's timezone.
      for (let day = 0; day <= 3; day++) {
        const candidate = addDays(date, day);
        if (Number(candidate.slice(5, 7)) === Number(monthDay[1]) &&
            Number(candidate.slice(8, 10)) === Number(monthDay[2])) {
          return { date: candidate, source: "page_label" as const };
        }
      }
      throw new Error("FLIGHT_ARRIVAL_DATE_INVALID");
    }
  }
  // First release is validated on domestic China routes. Do not guess overnight or time-zone offsets.
  return arrival >= departure
    ? { date, source: "same_day_default" as const }
    : { date: null, source: "unknown" as const };
}

/** Parse one DOM card. Input is a card's innerText, not the calendar, filters, or transfer section. */
export function parseFlightCard(text: string, date: string): Flight {
  const lines = text.split(/\r?\n/).map(l => l.replace(/\*\*/g, "").trim()).filter(Boolean);
  const start = lines.findIndex(l => TIME.test(l));
  if (start < 0 || !TIME.test(lines[start + 2] ?? "") || !lines[start + 1] || !lines[start + 3]) {
    throw new Error("FLIGHT_CARD_LAYOUT_CHANGED");
  }
  const departureTime = lines[start], arrivalTime = lines[start + 2];
  const dep = airport(lines[start + 1]), arr = airport(lines[start + 3]);
  if (TIME.test(dep.name) || TIME.test(arr.name) || !dep.name || !arr.name) throw new Error("FLIGHT_AIRPORT_MISSING");
  let cursor = start + 4;
  let dateLabel: string | undefined;
  if (/^\d{1,2}月\d{1,2}日/.test(lines[cursor] ?? "")) dateLabel = lines[cursor++];
  const priceText = lines[cursor] ?? "";
  const fare = priceText.match(PRICE);
  if (!fare) throw new Error("FLIGHT_PRICE_AMBIGUOUS");
  const value = Number(fare[1].replace(/,/g, ""));
  if (!Number.isFinite(value) || value <= 0) throw new Error("FLIGHT_PRICE_INVALID");
  let airlineIndex = -1;
  let airlineMatch: RegExpMatchArray | null = null;
  for (let i = cursor + 1; i < Math.min(lines.length, cursor + 5); i++) {
    const m = lines[i].match(FLIGHT_LINE);
    if (m && /[A-Z]/.test(m[2])) { airlineIndex = i; airlineMatch = m; break; }
  }
  if (!airlineMatch) throw new Error("FLIGHT_NUMBER_MISSING");
  const label = arrivalDate(dateLabel, date, departureTime, arrivalTime);
  const aircraftText = lines[airlineIndex + 1] ?? "";
  const knownTags = ["低价推荐", "精品快线", "含共享"];
  return {
    flight_number: airlineMatch[2], airline: airlineMatch[1],
    departure_date: date, departure_time: departureTime,
    departure_airport: dep.name, departure_terminal: dep.terminal,
    arrival_date: label.date, arrival_time: arrivalTime,
    arrival_airport: arr.name, arrival_terminal: arr.terminal,
    arrival_date_source: label.source,
    display_price: value, currency: "CNY", price_text: priceText,
    fare_text: lines.slice(cursor + 1, airlineIndex).join(" ") || null,
    aircraft: /^(空客|波音|商飞|机型|C919|ARJ|CRJ|ATR|EMB|[AB]\d{3})/.test(aircraftText) ? aircraftText : null,
    has_codeshare_options: lines.includes("含共享"),
    tags: knownTags.filter(t => lines.includes(t)),
    remaining_seats: null, tax_included: null
  };
}
function decodeObservation(doc: ScrapeDocument): FlightObservation {
  for (const item of doc.actions?.javascriptReturns ?? []) {
    let v: unknown = item.value;
    try {
      // Firecrawl may serialize an already JSON-stringified script return value again.
      for (let i = 0; i < 2 && typeof v === "string"; i++) v = JSON.parse(v);
    } catch { continue; }
    if (!v || typeof v !== "object") continue;
    const o = v as FlightObservation;
    if (o.kind !== "tongcheng-flight-observation-v1" || typeof o.url !== "string" ||
      typeof o.selected_date !== "string" || !Array.isArray(o.cards) || o.cards.length > 800 ||
      !o.cards.every(c => typeof c === "string" && c.length <= 3000) ||
      !Array.isArray(o.counts) || !o.counts.every(n => Number.isInteger(n) && n >= 0) ||
      !Number.isInteger(o.initial_count) || o.initial_count < 0 || !Number.isInteger(o.rounds) || o.rounds < 0 ||
      !Number.isInteger(o.stable_rounds) || o.stable_rounds < 0 ||
      ![o.stable, o.at_bottom, o.loading, o.truncated].every(b => typeof b === "boolean")) continue;
    return o;
  }
  // Missing execution evidence must not be silently replaced with an unverified first-screen scrape.
  throw new Error("FLIGHT_OBSERVATION_MISSING: browser actions did not return the flight-list observation");
}
function assertQueryUrl(value: string, query: FlightQuery): void {
  let u: URL;
  try { u = new URL(value); } catch { throw new Error("FLIGHT_SOURCE_URL_INVALID"); }
  if (/login|passport|signin/i.test(u.pathname + u.hostname)) throw new Error("FLIGHT_LOGIN_REQUIRED");
  if (u.protocol !== "https:" || u.hostname !== "m.ly.com" || u.pathname.replace(/\/$/, "") !== "/ft/touch/book1") {
    throw new Error("FLIGHT_UNEXPECTED_REDIRECT");
  }
  if (u.searchParams.get("fromCode") !== query.from_code || u.searchParams.get("toCode") !== query.to_code ||
    u.searchParams.get("date") !== query.date) throw new Error("FLIGHT_ROUTE_OR_DATE_MISMATCH");
}
export function normalizeFlightDocument(doc: ScrapeDocument, input: FlightQuery, fetchedAt: string): FlightResult {
  const query = validateFlightQuery(input);
  if (doc.metadata?.statusCode && doc.metadata.statusCode >= 400) throw new Error("FLIGHT_SOURCE_HTTP_ERROR");
  if (doc.metadata?.sourceURL) assertQueryUrl(doc.metadata.sourceURL, query);
  if (doc.metadata?.url) assertQueryUrl(doc.metadata.url, query);
  const observation = decodeObservation(doc);
  assertQueryUrl(observation.url, query);
  const match = observation.selected_date.match(/(?:^|\s)(\d{1,2})(?:-|月)(\d{1,2})(?:日|\b)/);
  const dateMatches = match ? Number(match[1]) === Number(query.date.slice(5, 7)) &&
    Number(match[2]) === Number(query.date.slice(8, 10)) : null;
  if (dateMatches === false) throw new Error("FLIGHT_SELECTED_DATE_MISMATCH");
  if (observation.cards.length === 0) throw new Error("FLIGHT_NO_CARDS: no verified flight list; this is not proof of no flights");

  const flights: Flight[] = [], seen = new Map<string, Flight>();
  let rejected = 0, duplicates = 0;
  const warnings = ["DISPLAY_PRICE_ONLY_TAX_AND_INVENTORY_UNKNOWN", "COLLAPSED_CODESHARES_AND_TRANSFERS_NOT_INCLUDED"];
  for (const card of observation.cards) {
    try {
      const flight = parseFlightCard(card, query.date);
      const id = [flight.flight_number, flight.departure_airport, flight.departure_time,
        flight.arrival_airport, flight.arrival_time, flight.arrival_date].join("|");
      const prior = seen.get(id);
      if (prior) {
        duplicates++;
        if (JSON.stringify(prior) !== JSON.stringify(flight)) {
          rejected++;
          warnings.push("CONFLICTING_DUPLICATE_CARD");
        }
        continue;
      }
      seen.set(id, flight); flights.push(flight);
    } catch { rejected++; }
  }
  if (flights.length === 0) throw new Error("FLIGHT_PARSE_EMPTY: observed cards did not match supported layout");
  const stable = observation.stable && observation.stable_rounds >= 3 && observation.at_bottom &&
    !observation.loading && !observation.truncated;
  if (!stable) warnings.push("FLIGHT_LIST_NOT_STABLE");
  if (dateMatches === null) warnings.push("SELECTED_DATE_NOT_VERIFIED");
  if (rejected > 0) warnings.push("SOME_FLIGHT_CARDS_NOT_PARSED");
  if (flights.some(f => f.arrival_date === null)) warnings.push("SOME_ARRIVAL_DATES_UNKNOWN");
  if (doc.warning) warnings.push("UPSTREAM_SCRAPE_WARNING");
  const ok = stable && dateMatches === true && rejected === 0 && !doc.warning;
  return {
    success: true, status: ok ? "ok" : "partial", query,
    expected_count: null, parsed_count: flights.length, is_complete: null, flights,
    coverage: { scope: "visible_main_listing", observed_count: observation.cards.length,
      parsed_count: flights.length, rejected_count: rejected, duplicate_count: duplicates,
      initial_count: observation.initial_count, scroll_rounds: observation.rounds,
      observed_list_stable: stable, selected_date_matches: dateMatches,
      all_observed_cards_parsed: rejected === 0, all_inventory_verified: false },
    warnings: [...new Set(warnings)],
    source: { provider: "tongcheng", url: buildTongchengUrl(query), fetched_at: fetchedAt, page_updated_at: null },
    cache: { hit: false, age_seconds: 0, ttl_seconds: TTL }
  };
}
export async function queryFlights(input: FlightQuery, env: Env): Promise<FlightResult> {
  const query = validateFlightQuery(input);
  const key = `flight:v1:tongcheng:${query.from_code}:${query.to_code}:${query.date}`;
  try {
    const cached = await env.TRAIN_CACHE.get<{ cached_at: number; result: FlightResult }>(key, "json");
    const age = cached ? Date.now() - cached.cached_at : NaN;
    if (cached && age >= 0 && age < TTL * 1000 && cached.result?.status === "ok" &&
      cached.result.query.from_code === query.from_code && cached.result.query.to_code === query.to_code &&
      cached.result.query.date === query.date) {
      return { ...cached.result, cache: { hit: true, age_seconds: Math.floor(age / 1000), ttl_seconds: TTL } };
    }
  } catch { /* Cache outage is not a data-source failure. */ }
  const doc = await scrapeWithKeyFailover(buildTongchengUrl(query), env, {
    mobile: true, onlyMainContent: false, waitFor: 3000, timeout: 60_000,
    actions: [{ type: "executeJavascript", script: FLIGHT_OBSERVATION_SCRIPT }]
  });
  const now = Date.now();
  const result = normalizeFlightDocument(doc, query, new Date(now).toISOString());
  if (result.status === "ok") {
    try {
      await env.TRAIN_CACHE.put(key, JSON.stringify({ cached_at: now, result }), { expirationTtl: TTL });
    } catch { result.warnings.push("CACHE_WRITE_FAILED"); }
  }
  return result;
}
