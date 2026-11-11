# Train Ticket MCP

A stateless MCP server on Cloudflare Workers. It accepts only departure station, arrival station and travel date; builds a Qunar train-ticket URL; asks Firecrawl for Markdown; parses the direct-train list with deterministic TypeScript rules; validates the result; and caches complete responses in Workers KV.

## Features

- MCP Streamable HTTP endpoint: `POST /mcp`
- Tool: `search_train_tickets(departure, arrival, date)`
- Five independent Firecrawl API key slots.
- On HTTP 401 only, automatically tries the next configured key.
- Remembers the last successful key slot in KV and tries it first next time.
- Each key can be rotated independently in Cloudflare Secrets Store; no code change is needed.
- 5-minute cache for complete results only.
- Regex/state-based Markdown parsing; no Firecrawl JSON Extraction charge.
- No Supabase or other database.
- Bearer-token protection for the MCP endpoint.

## Architecture

```
Agent -> Cloudflare Worker (MCP)
      -> Workers KV (query cache + last successful key slot)
      -> Firecrawl API (one of five Secrets Store keys)
      -> Markdown parser + completeness check
      -> normalized JSON -> Agent
```

## Cloudflare setup

### 1. Create Workers KV namespace

From the repository root:

```bash
npx wrangler kv namespace create TRAIN_CACHE
```

Copy the returned namespace ID into `wrangler.jsonc`, replacing `REPLACE_WITH_KV_NAMESPACE_ID`.

### 2. Create a Secrets Store and five secrets

In Cloudflare Dashboard, open **Workers & Pages / Secrets Store** (the account-level Secrets Store area).

Create one store, then create five secrets in that store with these exact names:

- `FIRECRAWL_KEY_1`
- `FIRECRAWL_KEY_2`
- `FIRECRAWL_KEY_3`
- `FIRECRAWL_KEY_4`
- `FIRECRAWL_KEY_5`

Set each secret's value to a Firecrawl API key. The five values are independent and can be edited/rotated independently later.

Copy the store ID and replace each `REPLACE_WITH_STORE_ID` in `wrangler.jsonc` with the same store ID. Do not put any API key values in this repository, Wrangler vars, or source code.

A slot can be left unused by creating its secret with an empty value if the dashboard permits it; otherwise create/populate that slot when you have another key. The Worker skips empty/unavailable slots.

### 3. Set the MCP access token

Create a long random token. Set it as a Worker secret:

```bash
npx wrangler secret put MCP_ACCESS_TOKEN
```

Paste the token when prompted. Keep it private; MCP clients must send it as `Authorization: Bearer <token>`.

For local development only, copy `.env.example` to `.dev.vars` and fill the values. Never commit `.dev.vars`.

### 4. Install and deploy

```bash
npm install
npm run typecheck
npm test
npm run deploy
```

The deployment will require the KV namespace ID, Secrets Store ID, all five named Secrets Store secrets, and `MCP_ACCESS_TOKEN` to be configured.

## MCP connection

- Endpoint: `https://<your-worker-subdomain>.workers.dev/mcp`
- Transport: MCP Streamable HTTP (stateless)
- Header: `Authorization: Bearer <MCP_ACCESS_TOKEN>`

Tool input:

```json
{
  "departure": "杭州东",
  "arrival": "北京南",
  "date": "2026-11-22"
}
```

## Five-key failover behavior

The Worker starts with the last successful slot stored in KV (slot 1 if no slot has succeeded yet). For each request:

1. Read the five secrets from Secrets Store.
2. Skip empty/unavailable slots.
3. Call Firecrawl with the current key.
4. If Firecrawl returns **401**, try the next slot, wrapping from slot 5 to slot 1.
5. On success, save that slot as the preferred slot for the next request.
6. For **403, 429, 5xx, network errors or timeout**, stop and return an error. These are not treated as invalid credentials.
7. If every configured key returns 401, return `FIRECRAWL_ALL_KEYS_UNAUTHORIZED`.

Each key can be rotated in place in Secrets Store without changing the binding name, Worker code, or MCP endpoint. No key value is returned in tool output or logs.

## Cache behavior

- Key: `train:v1:<departure-pinyin>:<arrival-pinyin>:<date>`
- TTL: 300 seconds.
- Only complete results are cached.
- Incomplete or unparsable pages are returned as tool errors and are not cached.
- Cache hits include `cache.hit` and `cache.age_seconds`.

## Notes and limitations

- The station slug is generated from Chinese station names using Pinyin. Verify uncommon station names against Qunar's route URL format.
- Parser completeness compares the page's declared direct-train count with the number of parsed records. If Qunar changes its Markdown layout, parsing fails closed instead of returning a silently partial list.
- The first version parses direct trains. Transfer itineraries are not included.
- Qunar page data is a snapshot, not a booking or inventory guarantee. Verify terms and permissions for automated access and commercial reuse before production use.
- The `/health` endpoint is public and reveals no secrets. The `/mcp` endpoint requires the bearer token.
