import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const build = process.env.FLIGHT_TEST_BUILD;
if (!build) throw new Error('Run npm run test:flights');
const { parseFlightCard, validateFlightQuery, buildTongchengUrl, normalizeFlightDocument, queryFlights } = require(join(build, 'flights.js'));
const { scrapeWithKeyFailover } = require(join(build, 'firecrawl.js'));
const { FLIGHT_OBSERVATION_SCRIPT } = require(join(build, 'flight-browser.js'));
const { parseTrainMarkdown } = require(join(build, 'parser.js'));
const fixture = readFileSync(new URL('./fixtures/tongcheng-hgh-bjs-2026-11-14.cards.txt', import.meta.url), 'utf8').trim().split(/\n\n+/);
const q = { from_code: 'HGH', to_code: 'BJS', date: '2026-11-14' };
const url = buildTongchengUrl(q);
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
function observation(changes = {}) {
  return { kind: 'tongcheng-flight-observation-v1', url, selected_date: '11-14',
    initial_count: 30, counts: [30,40,40,40,40,40], rounds: 5, at_bottom: true,
    loading: false, stable_rounds: 3, stable: true, truncated: false, cards: fixture, ...changes };
}
function document(changes = {}) {
  return { markdown: 'Calendar ¥1 and transfer ¥2 must not be parsed as main-list flights',
    metadata: { statusCode: 200, sourceURL: url, url },
    actions: { javascriptReturns: [{ type: 'string', value: JSON.stringify(observation(changes)) }] } };
}
function makeEnv() {
  const data = new Map(), writes = [];
  return { data, writes,
    TRAIN_CACHE: { async get(k, type) { const v = data.get(k); return v === undefined ? null : type === 'json' ? JSON.parse(v) : v; },
      async put(k, v, opts) { writes.push({ k, opts }); data.set(k, v); } },
    MCP_ACCESS_TOKEN: 'test-only-not-a-real-token',
    ...Object.fromEntries(Array.from({length: 6}, (_, i) => [`FIRECRAWL_KEY_${i + 1}`, `test-only-key-${i + 1}`])) };
}
function success(doc = document()) { return new Response(JSON.stringify({ success: true, data: doc }), { status: 200 }); }

test('city-code inputs normalize case and build exact fromCode/toCode/date query', () => {
  assert.deepEqual(validateFlightQuery({ ...q, from_code: ' hgh ', to_code: 'bjs' }), q);
  assert.equal(url, 'https://m.ly.com/ft/touch/book1?fromCode=HGH&toCode=BJS&date=2026-11-14');
  for (const from_code of ['杭州', 'HGH?x=1', 'HG', 'HGH1', '']) assert.throws(() => validateFlightQuery({ ...q, from_code }), /INVALID_CITY_CODE/);
});
test('invalid real dates and same origin/destination are rejected', () => {
  for (const date of ['2026-02-30','2026-13-01','not-date']) assert.throws(() => validateFlightQuery({ ...q, date }), /INVALID_DATE/);
  assert.throws(() => validateFlightQuery({ ...q, to_code: 'HGH' }), /INVALID_ROUTE/);
});
test('live DOM fixture parses all 40 observed cards without claiming inventory completeness', () => {
  const r = normalizeFlightDocument(document(), q, '2026-11-11T11:00:00Z');
  assert.equal(fixture.length, 40); assert.equal(r.parsed_count, 40); assert.equal(r.status, 'ok');
  assert.equal(r.coverage.rejected_count, 0); assert.equal(r.is_complete, null);
  assert.equal(r.expected_count, null); assert.equal(r.coverage.all_inventory_verified, false);
  assert.equal(Math.min(...r.flights.map(f => f.display_price)), 350);
  assert.equal(r.flights.at(-1).flight_number, 'CA1705');
});
test('flight number, cross-midnight date, airport, terminal and unknown taxes survive parsing', () => {
  const f = parseFlightCard(fixture[0], q.date);
  assert.equal(f.flight_number, 'MU5140'); assert.equal(f.departure_airport, '萧山');
  assert.equal(f.departure_terminal, 'T3'); assert.equal(f.arrival_terminal, null);
  assert.equal(f.arrival_date, '2026-11-15'); assert.equal(f.arrival_date_source, 'page_label');
  assert.equal(f.tax_included, null); assert.equal(f.remaining_seats, null); assert.equal(f.has_codeshare_options, true);
});
test('December-to-January rollover is derived from departure date', () => {
  const f = parseFlightCard(fixture[0].replace('11月15日', '1月1日'), '2026-12-31');
  assert.equal(f.arrival_date, '2027-01-01');
});
test('overnight time without a date label stays unknown', () => {
  const f = parseFlightCard(fixture[0].replace('11月15日 周日\n',''), q.date);
  assert.equal(f.arrival_date, null); assert.equal(f.arrival_date_source, 'unknown');
});
test('alphanumeric airline prefixes and un-discounted fare labels work', () => {
  const f = parseFlightCard(fixture[1].replace('河北航 NS8034','春秋 9C1234').replace('1.5折经济舱','经济舱'), q.date);
  assert.equal(f.flight_number, '9C1234'); assert.equal(f.fare_text, '经济舱');
});
test('ambiguous concatenated prices are rejected rather than treated as a number', () => {
  assert.throws(() => parseFlightCard(fixture[0].replace('¥350','¥350¥320'), q.date), /FLIGHT_PRICE_AMBIGUOUS/);
});
test('missing actions evidence never falls back to a seemingly complete Markdown list', () => {
  assert.throws(() => normalizeFlightDocument({ markdown: fixture.join('\n\n') }, q, 'now'), /FLIGHT_OBSERVATION_MISSING/);
});
test('wrong URL date and selected calendar date are independently rejected', () => {
  assert.throws(() => normalizeFlightDocument(document({ url: url.replace('11-14','11-13') }), q, 'now'), /ROUTE_OR_DATE_MISMATCH/);
  assert.throws(() => normalizeFlightDocument(document({ selected_date: '11-13' }), q, 'now'), /SELECTED_DATE_MISMATCH/);
});
test('login redirects are not returned as zero flights', () => {
  const d = document(); d.metadata.url = 'https://m.ly.com/login';
  assert.throws(() => normalizeFlightDocument(d, q, 'now'), /FLIGHT_LOGIN_REQUIRED/);
});
test('unstable scrolling and missing date evidence return partial coverage', () => {
  assert.equal(normalizeFlightDocument(document({ stable: false }), q, 'now').status, 'partial');
  assert.equal(normalizeFlightDocument(document({ selected_date: '' }), q, 'now').status, 'partial');
});
test('identical duplicates are deduplicated; conflicting prices make coverage partial', () => {
  const d = normalizeFlightDocument(document({ cards: [fixture[1], fixture[1]] }), q, 'now');
  assert.equal(d.parsed_count, 1); assert.equal(d.coverage.duplicate_count, 1);
  assert.equal(normalizeFlightDocument(document({ cards: [fixture[1], fixture[1].replace('¥350','¥399')] }), q, 'now').status, 'partial');
});
test('malformed cards are reported and do not silently disappear into complete results', () => {
  const r = normalizeFlightDocument(document({ cards: [...fixture, 'changed-layout'] }), q, 'now');
  assert.equal(r.coverage.rejected_count, 1); assert.equal(r.status, 'partial');
});
test('empty result is explicit failure, not a claimed absence of flights', () => {
  assert.throws(() => normalizeFlightDocument(document({ cards: [] }), q, 'now'), /FLIGHT_NO_CARDS/);
});
test('all six 401 responses rotate once each and fail without leaking keys', async () => {
  const env = makeEnv(), headers = [];
  globalThis.fetch = async (_, init) => { headers.push(init.headers.Authorization); return new Response('', { status: 401 }); };
  await assert.rejects(() => scrapeWithKeyFailover(url, env), /^Error: FIRECRAWL_ALL_KEYS_UNAUTHORIZED$/);
  assert.equal(headers.length, 6); assert.equal(new Set(headers).size, 6);
});
test('401 failover remembers the successful slot and next request reuses it', async () => {
  const env = makeEnv(), keys = [];
  globalThis.fetch = async (_, init) => {
    keys.push(init.headers.Authorization);
    return init.headers.Authorization.endsWith('key-1') ? new Response('', {status:401}) : success();
  };
  await scrapeWithKeyFailover(url, env); await scrapeWithKeyFailover(url, env);
  assert.deepEqual(keys, ['Bearer test-only-key-1','Bearer test-only-key-2','Bearer test-only-key-2']);
  assert.equal(env.writes.length, 1);
});
test('secret slots can be rotated in place and DISABLED/missing bindings are skipped', async () => {
  const env = makeEnv(); let value = 'test-only-new'; env.FIRECRAWL_KEY_1 = { get: async () => value };
  env.FIRECRAWL_KEY_2 = 'DISABLED'; env.FIRECRAWL_KEY_3 = undefined;
  const keys = []; globalThis.fetch = async (_, init) => { keys.push(init.headers.Authorization); return success(); };
  await scrapeWithKeyFailover(url, env); value = 'test-only-rotated'; await scrapeWithKeyFailover(url, env);
  assert.deepEqual(keys, ['Bearer test-only-new','Bearer test-only-rotated']);
});
for (const status of [402,403,429,500]) test(`HTTP ${status} stops without cycling the key pool`, async () => {
  let calls = 0; globalThis.fetch = async () => { calls++; return new Response('must-not-leak-test-only-key-1', {status}); };
  await assert.rejects(() => scrapeWithKeyFailover(url, makeEnv()), new RegExp(`^Error: FIRECRAWL_HTTP_${status}$`));
  assert.equal(calls, 1);
});
test('full query uses actions, writes separate flight cache, and skips upstream on cache hit', async () => {
  const env = makeEnv(); let calls = 0;
  globalThis.fetch = async (_, init) => {
    calls++; const b = JSON.parse(init.body);
    assert.equal(b.mobile, true); assert.equal(b.maxAge, 0); assert.deepEqual(b.formats, ['markdown']);
    assert.equal(b.actions[0].script, FLIGHT_OBSERVATION_SCRIPT); return success();
  };
  const a = await queryFlights(q, env), b = await queryFlights(q, env);
  assert.equal(a.cache.hit, false); assert.equal(b.cache.hit, true); assert.equal(calls, 1);
  assert.equal(a.source.fetched_at, b.source.fetched_at);
  assert.ok(env.data.has('flight:v1:tongcheng:HGH:BJS:2026-11-14'));
});
test('partial snapshots are never cached', async () => {
  const env = makeEnv(); let calls = 0;
  globalThis.fetch = async () => { calls++; return success(document({ stable: false })); };
  assert.equal((await queryFlights(q, env)).status, 'partial'); await queryFlights(q, env);
  assert.equal(calls, 2); assert.equal(env.data.size, 0);
});
test('KV write failure does not hide successfully fetched flights', async () => {
  const env = makeEnv(); env.TRAIN_CACHE.put = async () => { throw new Error('429'); };
  globalThis.fetch = async () => success();
  const r = await queryFlights(q, env); assert.equal(r.parsed_count, 40); assert.ok(r.warnings.includes('CACHE_WRITE_FAILED'));
});
test('browser script grows 30 to 40 cards and requires bottom + three stable rounds', async () => {
  let count = 30; const root = { scrollHeight: 2000, scrollTop: 0 };
  const context = {
    setTimeout: resolve => { count = 40; root.scrollHeight = 3000; resolve(); },
    location: { href: url }, getComputedStyle: () => ({display:'block',visibility:'visible'}),
    document: {
      scrollingElement: root, documentElement: root,
      querySelectorAll: selector => selector.includes('skeleton') ? [] : fixture.slice(0,count).map(innerText => ({innerText})),
      querySelector: () => ({innerText:'11-14'})
    },
    window: { innerHeight: 500, scrollTo: () => { root.scrollTop = root.scrollHeight - 500; } }
  };
  const result = JSON.parse(await vm.runInNewContext(FLIGHT_OBSERVATION_SCRIPT, context));
  assert.equal(result.initial_count, 30); assert.equal(result.cards.length, 40);
  assert.equal(result.stable_rounds, 3); assert.equal(result.stable, true);
});
test('unchanged train parser still handles numeric train IDs and hour-only durations', () => {
  const m = '当前筛选结果： **1** 趟车次\n\n12:15\n\n上海\n\n6时\n\n[1462](https://huoche.qunar.com/train/timetable/1462)\n\n18:15\n\n北京丰台\n\n**¥152.5**\n\n硬座 **有票**硬卧 **候补**\n\n## 上海到北京的中转方案';
  const r = parseTrainMarkdown(m, q.date); assert.equal(r.parsed_count, 1); assert.equal(r.trains[0].train_number, '1462');
});

test('disabled and unreadable first slots are actually skipped', async () => {
  const env = makeEnv();
  env.FIRECRAWL_KEY_1 = 'DISABLED';
  env.FIRECRAWL_KEY_2 = { get: async () => { throw new Error('secret unavailable'); } };
  const keys = []; globalThis.fetch = async (_, init) => { keys.push(init.headers.Authorization); return success(); };
  await scrapeWithKeyFailover(url, env);
  assert.deepEqual(keys, ['Bearer test-only-key-3']);
});
test('slot six wraps to slot one on 401', async () => {
  const env = makeEnv(); env.data.set('firecrawl:key-cursor', '5');
  const keys = []; globalThis.fetch = async (_, init) => {
    keys.push(init.headers.Authorization);
    return init.headers.Authorization.endsWith('key-6') ? new Response('', {status:401}) : success();
  };
  await scrapeWithKeyFailover(url, env);
  assert.deepEqual(keys, ['Bearer test-only-key-6', 'Bearer test-only-key-1']);
});
test('expired KV snapshots cause a fresh request', async () => {
  const env = makeEnv(); let calls = 0;
  globalThis.fetch = async () => { calls++; return success(); };
  await queryFlights(q, env);
  const key = 'flight:v1:tongcheng:HGH:BJS:2026-11-14';
  const cached = JSON.parse(env.data.get(key)); cached.cached_at = Date.now() - 301000;
  env.data.set(key, JSON.stringify(cached));
  assert.equal((await queryFlights(q, env)).cache.hit, false); assert.equal(calls, 2);
});
test('double JSON-serialized action results are accepted', () => {
  const d = document(); d.actions.javascriptReturns[0].value = JSON.stringify(d.actions.javascriptReturns[0].value);
  assert.equal(normalizeFlightDocument(d, q, 'now').parsed_count, 40);
});
