// Explicit, bounded metadata refresh. No background SDK requests or direct access.
require('dotenv').config();
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const accounts = require('../dist/lib/trade/account-manager.js');
const { closePool } = require('../dist/lib/trade/pg.js');
const { decryptBuffer } = require('../dist/lib/trade/crypto.js');
const { parseProxy } = require('../dist/src/x/proxy.js');
const { cookiesFromStorageState } = require('../dist/src/xactions/session.js');
const { createSocks5Fetch } = require('../dist/src/xactions/transport.js');
const { createHttpQuotaGate, reserveAdditionalHttpRequest } = require('../dist/src/xactions/account-http-quota.js');

async function main() {
  const root = process.env.XACTIONS_ROOT;
  const cache = process.env.XACTIONS_HOME;
  if (!root || !cache || !path.isAbsolute(cache)) throw Error('Configure XACTIONS_ROOT and absolute XACTIONS_HOME');
  await require('./xactions-http-loader.cjs').loadPinnedXActions(root);
  const sdk = await import(pathToFileURL(path.join(root, 'src/scrapers/twitter/http/queryIds.js')).href);
  const owner = 'query-refresh-' + randomUUID();
  const account = await accounts.pickAccount('profile', owner, process.argv[2], false, true);
  if (!account) throw Error('No available proxy account or quota; retry later');
  let decrypted;
  try {
    decrypted = decryptBuffer(account.session_encrypted);
    const cookie = cookiesFromStorageState(JSON.parse(decrypted.toString()));
    const transport = createSocks5Fetch(parseProxy(account.proxy_json));
    const charge = createHttpQuotaGate('profile', weight => reserveAdditionalHttpRequest(account.name, owner, weight));
    const signal = AbortSignal.timeout(90_000);
    let calls = 0;
    const result = await sdk.discoverQueryIds({ cacheDir: cache, persist: false,
      concurrency: 2, entryUrls: ['https://x.com/home'], fetch: async (input, init) => {
        const url = new URL(input);
        if (url.protocol !== 'https:' || !['x.com', 'abs.twimg.com'].includes(url.hostname) || ++calls > 20) {
          throw Error('Metadata host or request budget rejected');
        }
        signal.throwIfAborted();
        await charge();
        const headers = new Headers(init?.headers);
        if (url.hostname === 'x.com') headers.set('cookie', cookie);
        else { headers.delete('cookie'); headers.delete('authorization'); }
        const response = await transport(input, { ...init, headers, signal });
        if (response.status === 429) {
          await accounts.recordError(account.name, 'rate_limit', 0, owner);
          throw Error('Metadata rate limit; account cooldown applied');
        }
        return response;
      } });
    if (!result.operations.SearchTimeline) throw Error('SearchTimeline metadata missing');
    sdk.saveCache({ version: 1, fetchedAt: result.fetchedAt, source: result.source, operations: result.operations }, cache);
    console.log(JSON.stringify({ operations: result.count, requests: calls, failedChunks: result.source.chunksFailed.length }));
  } finally {
    decrypted?.fill(0);
    await accounts.releaseAccount(account.name, owner);
  }
}
main().catch(() => { console.error('XActions metadata refresh failed; check configuration, proxy and account quota'); process.exitCode = 1; }).finally(() => closePool());
