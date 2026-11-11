# Train + Flight Ticket MCP

One existing Cloudflare Worker, one `/mcp` endpoint, two read-only query tools. Version **1.1.0** adds Tongcheng flight lookup without changing the existing train tool's input or result schema.

## Agent inputs

### Flights: `search_flight_tickets`

Use **city codes**, not Chinese city names:

```json
{
  "from_code": "HGH",
  "to_code": "BJS",
  "date": "2026-11-14"
}
```

`from_code` / `to_code` must be three Latin letters. Lowercase is normalized to uppercase. The Worker uses the supplied codes directly and builds:

```text
https://m.ly.com/ft/touch/book1?fromCode=HGH&toCode=BJS&date=2026-11-14
```

HGH→BJS and SHA→BJS are validated examples. City searches can include several airports: keep each returned flight's actual airport and terminal. Format validation alone does not prove any arbitrary three-letter code is a valid Tongcheng city. Domestic one-way listings are the validated scope; international, return-trip, passenger-specific fares, and booking are not supported by this tool.

### Trains: `search_train_tickets`

The existing train tool still accepts station names:

```json
{
  "departure": "杭州东",
  "arrival": "北京南",
  "date": "2026-11-22"
}
```

## Existing deployment: no new bindings or keys

Keep the existing Worker name, `/mcp` URL and access token. This update reuses:

- `TRAIN_CACHE` (Workers KV), with separate `train:v1:...` and `flight:v1:tongcheng:...` key prefixes.
- Secrets Store bindings `FIRECRAWL_KEY_1` through `FIRECRAWL_KEY_6`.
- Worker secret `MCP_ACCESS_TOKEN` for `Authorization: Bearer <token>`.

The existing `wrangler.jsonc` and all resource IDs are unchanged. Do not recreate the configured resources. Secrets Store values remain managed in Cloudflare, never in GitHub. An unused key slot can contain `DISABLED`.

The shared Firecrawl client starts with the last successful slot. Only an upstream Firecrawl API **HTTP 401** advances to the next slot, wrapping after slot 6. HTTP 402 (credits), 403, 429, 5xx and network errors do **not** cycle the pool. A slot's latest secret value is read on each request. The preferred slot is written only when it changes; a cursor-write error cannot discard a successful scrape. This cursor is advisory, not a globally consistent lock.

## Flight collection and validation

1. Validate the city codes and real calendar date.
2. Check the five-minute flight cache in the existing KV namespace.
3. Request Firecrawl `/v2/scrape` with Markdown, `mobile: true`, `maxAge: 0`, and a deterministic `executeJavascript` action. No JSON Extraction / LLM parsing is requested.
4. The action waits for `.flight-main > .relative.f-dir.border-bottom`, scrolls to the bottom, and checks the card contents until three consecutive observations are stable. It stops after a bounded 18 rounds. A visible skeleton, truncation, or failure to reach the bottom prevents a stable result.
5. Return card `innerText` and loading evidence in `actions.javascriptReturns`. Parse those card texts in TypeScript. This preserves card boundaries, avoiding calendar prices, banners, filter labels and transfer recommendations.
6. Independently validate the requested URL, the final page URL, and selected calendar date.
7. Only `status: "ok"` snapshots are cached. Partial data is explicitly marked and not cached. Missing observation evidence, redirects, mismatched dates and unreadable lists return MCP tool errors, not an empty successful result.

The action only reads public rendered content and scrolls. It does not log in, submit bookings, access private APIs, or extract cookies. Automated access and reuse must still comply with the data source's terms and permissions.

## Flight result fields

Each `flights[]` record includes:

| Field | Meaning |
| --- | --- |
| `flight_number`, `airline` | Displayed flight number and airline name |
| `departure_date`, `departure_time` | Departure date and displayed local time |
| `departure_airport`, `departure_terminal` | Actual airport label and terminal, not the query city code |
| `arrival_date`, `arrival_time` | Arrival date and displayed local time |
| `arrival_airport`, `arrival_terminal` | Actual arrival airport label and terminal |
| `arrival_date_source` | `page_label`, `same_day_default`, or `unknown` |
| `display_price`, `currency`, `price_text` | Display price; CNY for this domestic-China adapter; raw price label retained |
| `fare_text`, `aircraft`, `tags` | Original fare wording, recognized aircraft label, and displayed tags |
| `has_codeshare_options` | Whether this card displays `含共享`; does not identify the operating airline |
| `remaining_seats`, `tax_included` | `null`: not established by the main listing |

`source.fetched_at` is the time this service received the scrape, not a guarantee of the supplier's own update time; `source.page_updated_at` remains `null`. Cache hits preserve the original timestamp and expose `cache.age_seconds`.

### Completeness is explicit, not assumed

- `status: "ok"`: observed main cards parsed, selected date matched, and scrolling reached a stable bottom state.
- `status: "partial"`: some cards or loading/date evidence are incomplete; use the returned warnings.
- `coverage.observed_list_stable`: whether the bounded scrolling check passed.
- `coverage.all_observed_cards_parsed`: whether every observed card was handled without rejection.
- `expected_count: null`, `is_complete: null`, `coverage.all_inventory_verified: false`: the site does not expose an authoritative inventory total to this collector.

Do not tell users these are **all available flights**. Collapsed codeshares, detailed fare families, transfers, baggage, tax inclusion, exact seats and bookability are not verified. An arrival date is taken from the displayed date label where available; same-day dates default only when arrival clock time is not earlier than departure. Otherwise the date remains unknown. No international timezone arithmetic is attempted.

## Install, check and deploy yourself

No new npm packages or dependency upgrades were introduced by the flight feature.

```bash
npm install
npm run typecheck
npm test
npx wrangler deploy --dry-run
npm run deploy
```

The independent flight/core regression suite can be run with:

```bash
npm run test:flights
```

It compiles the relevant TypeScript modules and runs Node's built-in test runner. The existing Vitest train tests are retained; `npm test` runs them and then the flight suite.

After deploying, refresh/reconnect the Agent's MCP tools list to discover `search_flight_tickets`. The endpoint and bearer token do not change. `/health` reports version `1.1.0`.

## Validation performed for this update

- Core TypeScript modules compile under TypeScript 5.8.3, strict mode.
- 31 deterministic tests cover the 40-card fixture, city codes, dates, cross-midnight/year rollover, missing actions, incorrect redirects, duplicate cards, partial snapshots, cache reuse, cache failure, and mocked six-key 401 failover.
- A live Firecrawl **Interact** browser run on 2026-11-11 executed the collection algorithm for HGH→BJS / 2026-11-14: initial 30 cards; observations `[30,40,40,40,40,40]`; bottom reached; no loading skeleton; three stable rounds. All 40 recorded card texts parsed successfully.
- The fixture `test/fixtures/tongcheng-hgh-bjs-2026-11-14.cards.txt` records those public DOM card texts. Its prices are historical test data, not current quotes. Scrape/session ID: `01a1ca55-2949-720f-acbd-f82851928ae9`.
- Production Worker deployment, authenticated MCP end-to-end calls, and Firecrawl REST `/scrape` action execution using the user's stored keys have **not** been performed for this update. The live check used the connector's Interact browser; REST payload behavior is covered by mocks and the official API contract.
- The editing container could not download npm dependencies; full dependency-backed `npm run typecheck`, Vitest, and Wrangler packaging must be run in your build environment. The core regression suite above was actually executed locally.

## References

- Firecrawl actions and deterministic JavaScript results: https://docs.firecrawl.dev/advanced-scraping-guide
- Firecrawl `/v2/scrape` response and options: https://docs.firecrawl.dev/api-reference/endpoint/scrape
- KV write limits: https://developers.cloudflare.com/kv/api/write-key-value-pairs/

## Original train behavior

The train parser remains unchanged: it isolates the current-filter section, supports letter-prefixed and numeric train IDs, accepts hour-only durations, and compares parsed rows with the page's declared row count. Same train numbers with different listed departures are preserved. It parses direct trains, not transfers. The original earlier samples reported 28/28, 29/29, 28/28 for Hangzhou–Beijing on 2026-11-21/22/23 and 54/54 for Shanghai–Beijing on 2026-11-21; these historical sample counts are not a live inventory guarantee.
