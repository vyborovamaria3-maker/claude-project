// Real production Next.js responses. No credentials, backend, database or external actions.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
const cwd = fileURLToPath(new URL('../', import.meta.url));
const reservation = createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
  cwd, env: { ...process.env, NODE_ENV: 'production', ADMIN_SITE_URL: 'https://admin.example' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-4000); });
const get = path => fetch(base + path, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await get('/api/build-info'); ready = true; break; } catch {}
    if (child.exitCode !== null) throw new Error(output);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert(ready, output);
  for (const [path, module] of [
    ['/admin', ''], ['/admin/x-collector', 'x-collector'], ['/admin/tg-collector', 'tg-collector'], ['/admin/tg-invite', 'tg-invite'],
    ['/tg-collector', 'tg-collector'], ['/tginvite', 'tg-invite'], ['/settings/tginvite', 'tg-invite'], ['/launch/tginvite', 'tg-invite'], ['/trade/tginvite', 'tg-invite'],
  ]) {
    const response = await get(path);
    assert.equal(response.status, 307, path);
    assert.equal(response.headers.get('location'), 'https://admin.example/' + (module ? 'collectors/' + module : ''), path);
  }
  for (const [tab, module] of [['xcollector', 'x-collector'], ['tgcollector', 'tg-collector'], ['tginvite', 'tg-invite']]) {
    const response = await get('/settings?tab=' + tab);
    assert.equal(response.status, 307);
    assert.equal(response.headers.get('location'), 'https://admin.example/collectors/' + module);
  }
  for (const [path, status] of [['/api/integrations/x-collector', 401], ['/api/integrations/tg-collector', 404], ['/api/tginvite/identity', 401], ['/admin/twitter-registry', 401]]) {
    assert.equal((await get(path)).status, status, path);
  }
  const settings = await get('/settings');
  assert.equal(settings.status, 200);
  const html = await settings.text();
  assert.doesNotMatch(html, /settings\.tab\.(?:xcollector|tgcollector)|nav\.administration/);
  console.log('PASS production HTTP: 12 legacy redirects to separate admin-site, no collector tabs, anonymous APIs denied');
} finally {
  child.kill();
  if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
}
