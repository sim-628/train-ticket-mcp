/** Executes only against public, rendered DOM. No login, booking, private API, or cookies. */
export const FLIGHT_OBSERVATION_SCRIPT = String.raw`(async () => {
  const selector = '.flight-main > .relative.f-dir.border-bottom';
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const nodes = () => Array.from(document.querySelectorAll(selector));
  const text = el => el ? (el.innerText || '').trim() : '';
  const cards = () => nodes().map(text);
  const visible = el => {
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
  };
  const loading = () => Array.from(document.querySelectorAll('.flight-main .skeleton-screen')).some(visible);
  const atBottom = () => {
    const root = document.scrollingElement || document.documentElement;
    return root.scrollHeight - root.scrollTop - window.innerHeight <= 8;
  };
  // Bounded wait for the asynchronously rendered flight cards.
  for (let i = 0; i < 16 && nodes().length === 0; i++) await sleep(500);
  const initialCount = nodes().length;
  const counts = [initialCount];
  let previous = JSON.stringify(cards()), stableRounds = 0, rounds = 0;
  for (let i = 0; i < 18 && nodes().length > 0; i++) {
    const root = document.scrollingElement || document.documentElement;
    window.scrollTo(0, root.scrollHeight);
    await sleep(700);
    const current = JSON.stringify(cards());
    counts.push(nodes().length);
    rounds++;
    stableRounds = current === previous && atBottom() && !loading() ? stableRounds + 1 : 0;
    previous = current;
    if (stableRounds >= 3) break;
  }
  const allCards = cards();
  const truncated = allCards.length > 800 || allCards.some(c => c.length > 3000);
  return JSON.stringify({
    kind: 'tongcheng-flight-observation-v1',
    url: location.href,
    selected_date: text(document.querySelector('.cal-item.cur-day .day')) ||
      text(document.querySelector('.cal-item.cur-day')),
    initial_count: initialCount, counts, rounds,
    at_bottom: atBottom(), loading: loading(),
    stable_rounds: stableRounds,
    stable: stableRounds >= 3 && atBottom() && !loading() && !truncated,
    truncated,
    cards: allCards.slice(0, 800).map(c => c.slice(0, 3000))
  });
})()`;
