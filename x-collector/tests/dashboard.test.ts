import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const load = createRequire(__filename);
import { test } from 'node:test';
import { chromium } from 'playwright';
const bundledChromium = load('@sparticuz/chromium').default as typeof import('@sparticuz/chromium').default;
import { server } from '../scripts/dashboard';

test('dashboard boots under CSP, isolates API errors and restores Mint chart', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.TEST_CHROMIUM_PATH ?? await bundledChromium.executablePath(), args: bundledChromium.args });
  server.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  try {
    const base = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(base + '/api/mint/full')).status, 400);
    assert.equal((await fetch(base + '/api/ultra/rebuild')).status, 405);
    assert.equal((await fetch(base + '/api/ultra/rebuild', { method: 'POST', headers: { Origin: 'https://untrusted.example' } })).status, 403);
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    let failHype = true;
    await page.route('**/api/**', async route => {
      const endpoint = new URL(route.request().url()).pathname;
      if (endpoint === '/api/hype/top' && failHype) {
        await route.fulfill({ status: 500, json: { error: 'test outage' } }); return;
      }
      const responses: Record<string, unknown> = {
        '/api/digest': [{ metric: 'collected', value: '17' }],
        '/api/tasks': { queue: [], dlq: 0 },
        '/api/mint/full': { summary: { total_tweets: 2, unique_authors: 1, total_views: '42' }, dailyFunnel: [{ day: '2026-10-07', tweets: 2 }], topAuthors: [] },
        '/api/hype/top': [{ mint: 'example', hype_score: 75 }],
      };
      await route.fulfill({ json: responses[endpoint] ?? [] });
    });
    const response = await page.goto(`http://127.0.0.1:${address.port}`);
    assert(response?.headers()['content-security-policy'].includes("script-src 'self'"));
    await page.getByText('collected', { exact: true }).waitFor();
    await page.getByText('/api/hype/top?limit=30: HTTP 500: test outage', { exact: true }).waitFor();
    for (const tab of ['Overview', 'Mint', 'Hype', 'Ultra', 'Shillers', 'Trending', 'Leaders', 'System']) {
      await page.getByRole('button', { name: tab, exact: true }).click();
      assert.equal(new URL(page.url()).hash, '#' + tab.toLowerCase());
    }
    await page.getByRole('button', { name: 'Mint', exact: true }).click();
    await page.getByPlaceholder('Mint address...').fill('test-mint');
    await page.getByRole('button', { name: 'Загрузить', exact: true }).click();
    await page.locator('canvas').waitFor();
    await page.waitForFunction(() => {
      const chart = (window as unknown as { Chart: { getChart: (canvas: Element) => unknown } }).Chart;
      return !!chart.getChart(document.querySelector('canvas')!);
    });
    await page.getByRole('button', { name: 'System', exact: true }).click();
    await page.getByRole('button', { name: 'Mint', exact: true }).click();
    await page.waitForFunction(() => !!(window as unknown as { Chart: { getChart: (canvas: Element) => unknown } }).Chart.getChart(document.querySelector('canvas')!));
    failHype = false;
    await page.getByRole('button', { name: 'Обновить', exact: true }).click();
    await page.waitForFunction(() => !document.body.textContent?.includes('test outage'));
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
