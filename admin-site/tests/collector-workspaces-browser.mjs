// Standalone compiled UI with synthetic APIs only. No real sessions or external actions.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../solana-launcher/package.json', import.meta.url));
const { chromium } = require('playwright');
const staticRoot = new URL('../app/static/', import.meta.url);
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://fixture').pathname;
    const relative = pathname === '/' ? 'index.html' : pathname.startsWith('/collectors/') ? 'collector-workspaces/index.html' : pathname.startsWith('/static/') ? pathname.slice(8) : '';
    if (!relative || relative.includes('..')) { response.writeHead(404); response.end(); return; }
    const body = await readFile(new URL(relative, staticRoot));
    const embedded = pathname.startsWith('/collectors/') && new URL(request.url, 'http://fixture').searchParams.get('embedded') === '1';
    response.setHeader('Content-Security-Policy', `default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors ${embedded ? "'self'" : "'none'"}; base-uri 'self'; form-action 'self'`);
    response.setHeader('Content-Type', relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : 'text/html');
    response.end(body);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
try {
  process.env.X_COLLECTOR_SMOKE_URL = origin;
  await import('../../solana-launcher/tests/xcollector-local-smoke.mjs');
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [], requests = [];
  let enabled = true, denied = false;
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    assert.equal(url.origin, origin, 'All browser traffic must stay on admin-site');
    if (!url.pathname.startsWith('/api/')) return route.continue();
    requests.push({ path: url.pathname, method: route.request().method() });
    if (url.pathname === '/api/rpc-health') return route.fulfill({ json: { status: 'ok', latency: 12 } });
    if (url.pathname === '/api/integrations/apify') return route.fulfill({ json: { config: { tokenConfigured: false, apiBaseUrl: '', sandboxActorId: '', pumpfunActorId: '' }, recentRuns: [], recentSyncs: [], latestSandboxRun: null, latestPumpfunRun: null } });
    if (url.pathname === '/api/blockchain/settings') return route.fulfill({ json: { values: { primary: '', fallback: '', batchSize: 5, concurrency: 1, requestsPerSecond: 1, timeoutMs: 5000, retries: 0, retryDelayMs: 100, enabled: false }, slots: [], alchemyConfigured: false, metrics: { errors: 0, retries: 0 }, collection: { collectedEvents: 0, targets: [] }, runs: [], imports: [] } });
    if (url.pathname === '/api/me') return route.fulfill({ status: denied ? 401 : 200, json: { username: 'fixture-admin' } });
    if (url.pathname === '/api/tginvite/identity') return route.fulfill({ json: { ownerId: '123e4567-e89b-12d3-a456-426614174000' } });
    if (url.pathname === '/api/integrations/x-collector') return route.fulfill({ json: { installed:true,dirExists:true,nodeModulesPresent:true,env:{databaseUrlConfigured:true,masterKeyConfigured:true},migrations:{complete:true,missing:[],path:'fixture'},processes:{worker:null,scheduler:null,dashboard:null},health:{worker:{reachable:false,detail:'fixture'},dashboard:{reachable:false,detail:'fixture'}},db:{reachable:true,detail:'fixture'} } });
    if (url.pathname.endsWith('/session')) return route.fulfill({ json: { connected: true } });
    if (url.pathname === '/api/integrations/tg-collector') {
      if (url.searchParams.get('mode') === 'memecoin') return route.fulfill({ json: { tokenStats: { tokens_total: 0, unresolved_addresses: 0, analysis_backfill_remaining: 0, ticker_mentions_24h: 0, confirmed_tokens_24h: 0, signals_24h: 0, market_snapshots_24h: 0 }, tokens: [], channels: [], unresolvedTickers: [], signals: [] } });
      if (route.request().method() === 'POST') {
        const action = route.request().postDataJSON().action;
        if (action === 'start' || action === 'stop') enabled = action === 'start';
      }
      return route.fulfill({ json: { configured: true, workerOnline: true, collectionEnabled: enabled, heartbeatAt: new Date().toISOString(), proxy: { enabled: false, configured: false }, stats: { sources: 0, spam_sources: 0, messages: 0, running: 0, failed: 0 }, runtimeMetrics: { messages_total: 0, messages_per_day: 0, links_total: 0, links_active_total: 0, links_per_day: 0, jobs_pending: 0, jobs_failed: 0, flood_wait_active: false }, sources: [], sourceOptions: [], messages: [], page: 0, sourcePage: 0 } });
    }
    if (url.pathname.endsWith('/graph')) return route.fulfill({ json: { nodes: [], edges: [], metrics: [], sharedAddresses: [], observedAddresses: [], total: 0, days: 90 } });
    return route.fulfill({ json: { authorized: false, connected: false, channels: [], jobs: [], messages: [], items: [], candidates: [], stats: {}, settings: null, status: 'unavailable' } });
  });
  await page.goto(origin + '/collectors/tg-collector');
  await page.getByRole('heading', { name: 'TG Collector', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Остановить', exact: true }).click();
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(button => button.textContent.includes('Запустить парсинг'))?.disabled);
  assert.equal(enabled, false);
  await page.getByRole('button', { name: 'Запустить парсинг', exact: true }).click();
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(button => button.textContent.includes('Остановить'))?.disabled);
  assert.equal(enabled, true);
  assert.equal(await page.getByLabel('Ключ доступа TG Collector').count(), 0);
  console.log('PASS standalone TG Collector: full component, admin connection, mocked stop/start');
  await page.goto(origin + '/collectors/tg-invite');
  await page.getByRole('heading', { name: 'TGInvite', exact: true }).waitFor();
  for (const tab of ['dashboard', 'Data Set TG', 'parser', 'analytics', 'monitor', 'import', 'channels', 'ai', 'users', 'goals', 'abtest', 'schedule', 'templates', 'accounts', 'webhooks', 'settings']) {
    await page.getByRole('button', { name: tab, exact: true }).click();
    await page.waitForTimeout(50);
  }
  assert.equal(requests.some(request => request.path === '/api/tginvite/identity'), true);
  assert.equal(requests.some(request => request.path.startsWith('/api/v1/telegram/teragram')), true);
  for (const module of ['diagnostics', 'apify', 'blockchain']) {
    await page.goto(origin + '/collectors/' + module);
    await page.locator('nav a[aria-current="page"]').filter({ hasText: new RegExp(module, 'i') }).waitFor();
    await page.waitForTimeout(700);
  }
  assert.equal(requests.some(request => request.path === '/api/blockchain/settings'), true);
  assert.equal(requests.some(request => request.path === '/api/integrations/apify'), true);
  assert.equal(requests.some(request => request.path === '/api/rpc-health'), true);
  assert.deepEqual(errors, []);
  denied = true;
  await page.reload();
  await page.getByRole('alert').filter({ hasText: 'Требуется вход администратора' }).waitFor();
  console.log('PASS standalone TG Invite: 16 original tabs, owner identity, same-origin TeraGram, login denial, no runtime errors');
  denied = false;
  let popups = 0;
  page.on('popup', () => popups++);
  await page.goto(origin + '/#collector-tg-collector');
  await page.locator('#appView').waitFor({ state: 'visible' });
  for (const module of ['tg-collector', 'x-collector', 'tg-invite', 'diagnostics', 'apify', 'blockchain']) {
    if (module === 'tg-collector') await page.locator('#tgCollectorUserNav').click();
    else {
      await page.locator('#xCollectorNav').click();
      await page.locator(`[data-collector-tab="${module}"]`).click();
    }
    const frame = page.frameLocator(`iframe[data-collector-workspace="${module}"]`);
    await frame.locator('.collector-console[data-embedded=true]').waitFor();
    assert.equal(new URL(page.url()).origin, origin);
    assert.equal(new URL(page.url()).pathname, '/');
    assert.equal(context.pages().length, 1);
    assert.equal(await page.locator('#navigation').isVisible(), true);
    assert.equal(await frame.locator('nav[aria-label="Collector administration"]').count(), 0);
  }
  assert.equal(popups, 0);
  assert.equal(await page.locator('#navigation [data-view^="collector-"]').count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS integrated admin shell: six views, one tab, same origin, unchanged pathname, no popup or duplicate navigation');
  process.env.TG_COLLECTOR_SMOKE_URL = origin;
  await import('../../solana-launcher/tests/tg-collector-graph-smoke.mjs');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
