// Invented state for the AI tiles: a coding session, a chat, their limits.

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const chatgpt = (now) => {
  const conversation = {
    id: 'c1', title: 'Weekend trip packing', updatedAt: new Date(now - 4 * MIN).toISOString(),
    messages: [
      { role: 'user', text: 'What should I pack for two days in the mountains in October?' },
      { role: 'assistant', text: 'Layers matter most. Take:\n\n- a warm mid layer and a rain shell\n- boots you have already worn in\n- a hat, gloves and a spare pair of socks' },
      { role: 'user', text: 'And for food on the trail?' },
      { role: 'assistant', text: 'Keep it light and salty: nuts, dried fruit, a couple of sandwiches for the first day and a flask of something hot.' },
    ],
  };
  const plan = { limits: { buckets: [{ primary: { pct: 24, windowMins: 300 }, secondary: { pct: 41, windowMins: 10080 } }] } };
  return {
    answers: {
      '/api/chatgpt': { conversations: [{ id: 'c1', title: conversation.title, updatedAt: conversation.updatedAt, count: 4, lastRole: 'assistant' }], active: [] },
      '/api/chatgpt/conversation': { ok: true, conversation },
      '/api/ai/cli/status': { installed: true, loggedIn: true },
      '/api/ai/cli/models': { models: [] },
    },
    events: { codex: { app: plan } },
  };
};

function usageDays(now, base) {
  return Array.from({ length: 14 }, (_, i) => {
    const day = new Date(now - (13 - i) * DAY).toISOString().slice(0, 10);
    const tokens = Math.round(base * (0.45 + ((i * 37) % 11) / 10));
    return { day, date: day, tokens, cacheRead: Math.round(tokens * 0.7) };
  });
}

export const claude = (now) => {
  const session = {
    id: '7f3a91c2-5d10-4be8-a1f0-2c9e6b7d4e11', project: 'harbor-shop', name: 'Checkout totals', branch: 'fix/cart-rounding',
    state: 'waiting', startedAt: now - 38 * MIN, ageMs: 40000, waitFor: { kind: 'permission', forMs: 40000 },
    // Open in a terminal with the mod listening: the state most sessions are in.
    terminal: true, modCommands: true, permissionMode: 'acceptEdits',
    model: 'claude-opus-5-5', effort: 'high', contextPct: 42, linesAdded: 128, linesRemoved: 37, cost: 2.18,
    todos: [
      { status: 'done', text: 'Reproduce the rounding error' },
      { status: 'done', text: 'Add a failing test' },
      { status: 'done', text: 'Round once, at the end' },
      { status: 'doing', text: 'Push the branch' },
    ],
    activity: [
      { tool: 'Read', detail: 'src/cart/total.ts', ms: 400, at: now - 7 * MIN },
      { tool: 'Edit', detail: 'src/cart/total.ts', ms: 900, at: now - 4 * MIN },
      { tool: 'Bash', detail: 'npm test', ms: 41000, at: now - 2 * MIN },
    ],
    subagents: [
      { id: 'a1', type: 'Explore', desc: 'Find every rounding call', model: 'claude-sonnet-5-5', status: 'done', tools: 14, tokens: 48000, endedMs: 6 * MIN },
      { id: 'a2', type: 'Review', desc: 'Check the receipts stay the same', model: 'claude-opus-5-5', status: 'running', tool: 'Read', detail: 'test/receipts.test.ts', tools: 6, tokens: 21000, ageMs: 2 * MIN },
    ],
  };
  const others = [
    { id: 'b81c44e0-92aa-47f1-8e6d-1a2b3c4d5e6f', project: 'tide-tables', name: 'Offline mode', branch: 'main', state: 'running', startedAt: now - 12 * MIN, ageMs: 4000, tool: 'Edit', toolDetail: 'src/sync/queue.ts', toolForMs: 3000, runForMs: 21000, model: 'claude-sonnet-5-5', cost: 0.64 },
    { id: 'd27e0f55-3c41-4f8a-9b12-6e5d4c3b2a10', project: 'lantern-docs', name: 'Translate the guide', branch: 'docs/fr', state: 'running', startedAt: now - 6 * MIN, ageMs: 9000, tool: 'Read', toolDetail: 'guide/install.md', model: 'claude-sonnet-5-5', cost: 0.31 },
    { id: 'e93a7b10-6f2c-4d11-b7a4-0f1e2d3c4b5a', project: 'field-notes', name: 'Search index', state: 'idle', startedAt: now - 2 * HOUR, ageMs: 9 * MIN, model: 'claude-opus-5-5', cost: 1.12 },
  ];
  const fiveHour = { pct: 34, resetsAt: Math.round((now + 2 * HOUR) / 1000) };
  const sevenDay = { pct: 58, resetsAt: Math.round((now + 3 * DAY) / 1000) };
  const usage = {
    today: { tokens: 18_400_000 }, week: { tokens: 96_200_000 },
    window: { days: 30, startsAt: now - 30 * DAY, dataFrom: now - 30 * DAY, tokens: 412_000_000, cost: 318.4 },
    cacheHitRate: 0.86, daily: usageDays(now, 14_000_000), sessions: [],
  };
  const approval = { id: 'p1', kind: 'permission', sessionId: session.id, project: session.project, model: session.model, tool: 'Bash', detail: 'git push origin fix/cart-rounding', risks: ['publish'], expiresInMs: 8 * MIN + 41000 };
  const feed = { live: { sessions: [session, ...others], approvals: [approval], limits: { fiveHour, sevenDay }, mod: { version: '0.4.0', ageMs: 2000 } }, usage, budget: { weekly: 0 }, titles: {}, runs: [] };
  const say = (role, text, ago) => ({ role, text, at: now - ago });
  const worked = (ago, ...tools) => ({ role: 'assistant', text: '', at: now - ago, tools: tools.map(([tool, detail]) => ({ tool, detail })) });
  return {
    answers: {
      '/api/claude': feed,
      '/api/claude/link': { linked: true, complete: true },
      '/api/claude/transcript': {
        ok: true,
        messages: [
          worked(8 * MIN, ['Read', 'src/cart/total.ts'], ['Read', 'test/cart.test.ts'], ['Edit', 'test/cart.test.ts'], ['Bash', 'npm test -- cart']),
          say('assistant', 'Each line is rounded before it is added, so the error grows with the number of items. I added a failing test with three lines at 19.99.', 5 * MIN),
          say('user', 'Good. Fix it and keep the receipts the same.', 2 * MIN),
          worked(90 * 1000, ['Edit', 'src/cart/total.ts'], ['Bash', 'npm test'], ['Bash', 'git commit -am "Round the total once"']),
          say('assistant', 'The fix rounds once, at the end of `orderTotal`, and the whole suite passes. Pushing the branch.', 40 * 1000),
        ],
      },
      '/api/claude/projects': { ok: true, projects: [] },
    },
    events: { claude: feed },
    // At this width the side panel would stack over the thread and cut it short.
    stage: 'document.querySelector(".cw-aside-hide")?.click()',
  };
};

export const openaicodex = (now) => {
  const days = usageDays(now, 2_600_000).map(({ date, tokens }) => ({ date, tokens }));
  const thread = (id, title, project, source, ago) => ({ id, title, project, source, status: 'idle', updatedAt: now - ago });
  const app = {
    state: 'ok', account: { plan: 'plus' }, caps: {},
    limits: { buckets: [{ primary: { pct: 31, windowMins: 300, resetsAt: now + 3 * HOUR }, secondary: { pct: 46, windowMins: 10080, resetsAt: now + 4 * DAY } }] },
    threads: [
      thread('t1', 'Resize uploaded photos on the server', 'harbor-shop', 'app', 2 * HOUR),
      thread('t2', 'Why does the CI cache miss?', 'tide-tables', 'cli', 26 * HOUR),
    ],
    usage: { today: 2_140_000, last7: 15_800_000, last30: 61_300_000, lifetime: 248_000_000, streak: 9, days },
  };
  const live = {
    approvals: [{
      id: 'x1', sessionId: 's2', project: 'tide-tables', model: 'gpt-5-codex', tool: 'apply_patch', risks: [], expiresInMs: 72000,
      detail: {
        kind: 'patch', added: 18, removed: 64,
        files: [
          { verb: 'move', path: 'src/upload/retry.ts', to: 'src/upload/backoff.ts' },
          { verb: 'update', path: 'src/upload/index.ts' },
          { verb: 'delete', path: 'src/upload/old-retry.ts' },
        ],
      },
    }],
    sessions: [
      { id: 's1', task: 'Move the importer to streams', project: 'harbor-shop', model: 'gpt-5-codex', state: 'running', ageMs: 6 * MIN },
      { id: 's2', task: 'Fix the flaky upload test', project: 'tide-tables', model: 'gpt-5-codex', state: 'waiting', ageMs: 14 * MIN },
    ],
  };
  const link = { linked: true, complete: true, trust: { trusted: true } };
  const feed = { app, live, link };
  return { answers: { '/api/codex': feed, '/api/codex/link': link }, events: { codex: feed } };
};
