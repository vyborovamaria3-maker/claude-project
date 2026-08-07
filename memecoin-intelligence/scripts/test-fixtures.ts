process.env.DATA_PROVIDER='fixture';
process.env.FIXTURE_PATH='./fixtures/x-posts.json';
const { getProvider } = await import('../src/server/providers/index.js');
const provider=getProvider();
const byAddress=await provider.search('"3jX8p8QumtfccakGib95yi4pPDNgQnDJEMmwjk1Upump"');
const byTicker=await provider.search('$TEST');
if(byAddress.mentions.length!==3) throw new Error(`Expected 3 address posts, got ${byAddress.mentions.length}`);
if(byTicker.mentions.length!==3) throw new Error(`Expected 3 ticker posts, got ${byTicker.mentions.length}`);
console.log('Fixture provider OK');
