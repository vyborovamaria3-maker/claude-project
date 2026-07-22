import { chromium } from 'playwright';

const MINT = '5Kdv682sUpVCWbhdGPH74UvFd1TkRrcqv1JdDKxGpump';
const URL = `http://localhost:3000/token-launch/chart?mint=${MINT}`;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  const consoleMessages = [];

  page.on('console', msg => {
    const text = `[${msg.type()}] ${msg.text()}`;
    consoleMessages.push(text);
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', err => {
    errors.push(`PAGE ERROR: ${err.message}`);
  });

  try {
    console.log(`Navigating to ${URL}`);
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log('Waiting for canvas...');
    await page.waitForSelector('canvas', { timeout: 20000 });
    console.log('Canvas found, waiting 10s for chart to render...');
    await page.waitForTimeout(10000);

    // Count canvases
    const canvasCount = await page.locator('canvas').count();
    console.log(`Found ${canvasCount} canvas elements`);

    // Check if any canvas has non-empty pixels
    const result = await page.evaluate(() => {
      const canvases = Array.from(document.querySelectorAll('canvas'));
      const results = [];
      for (let i = 0; i < canvases.length; i++) {
        const c = canvases[i];
        const ctx = c.getContext('2d');
        if (!ctx) { results.push({ i, ok: false, reason: 'no ctx' }); continue; }
        try {
          const data = ctx.getImageData(0, 0, c.width, c.height).data;
          let nonBg = 0;
          for (let j = 0; j < data.length; j += 4) {
            const r = data[j], g = data[j + 1], b = data[j + 2], a = data[j + 3];
            // Background is ~#0a0a0f. Count pixels significantly different.
            if (a > 0 && (r > 30 || g > 30 || b > 30)) nonBg++;
          }
          results.push({ i, w: c.width, h: c.height, nonBgPixels: nonBg });
        } catch (e) {
          results.push({ i, ok: false, reason: e.message });
        }
      }
      return results;
    });
    console.log('Canvas analysis:', JSON.stringify(result, null, 2));

    const hasContent = result.some(r => r.nonBgPixels && r.nonBgPixels > 100);
    
    await page.screenshot({ path: 'graph.png', fullPage: false });
    console.log('Screenshot saved to graph.png');

    if (hasContent) {
      console.log('\n✅ PASS: Chart has rendered content');
    } else {
      console.log('\n❌ FAIL: No chart content detected');
      errors.push('Canvas is empty / no candles rendered');
    }
  } catch (e) {
    console.log('FAIL: Error during test:', e.message);
    errors.push(e.message);
  }

  if (errors.length > 0) {
    console.log('\n--- Browser errors ---');
    errors.forEach(e => console.log(e));
  }
  console.log('\n--- Last 20 console messages ---');
  consoleMessages.slice(-20).forEach(m => console.log(m));

  await browser.close();
  process.exit(errors.length > 0 ? 1 : 0);
})();
