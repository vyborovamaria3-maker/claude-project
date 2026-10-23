const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');

// Exercise the parser resolved by Anchor, without loading a workspace or wallet.
// Resource-heavy synthetic inputs run in bounded children, never the build process.
const code=String.raw`
 const assert=require('node:assert/strict'),{createRequire}=require('node:module');
 const toml=createRequire(require.resolve('@coral-xyz/anchor'))('toml');
 const mode=process.argv[1];
 if(mode==='anchor-config'){
  const doc=Buffer.from('[provider]\ncluster="localnet"\nwallet="offline-fixture.json"\n[programs.localnet]\nfixture="offline-only"\n[features]\nseeds=true\n');
  const parsed=toml.parse(doc);
  assert.equal(parsed.provider.cluster,'localnet');
  assert.equal(parsed.programs.localnet.fixture,'offline-only');
  assert.equal(parsed.features.seeds,true);
 }else if(mode==='array-tables'){
  const count=20000,doc=Array.from({length:count},(_,i)=>'[[t'+i+']]\nv=1').join('\n');
  const parsed=toml.parse(doc);
  assert.equal(Object.keys(parsed).length,count);assert.equal(parsed.t19999[0].v,1);
 }else if(mode==='dotted-key'||mode==='table-path'){
  const keys=Array.from({length:25000},(_,i)=>'k'+i),key=keys.join('.');
  let value=toml.parse(mode==='dotted-key'?key+'=1':'['+key+']\nv=1');
  for(const part of keys)value=value[part];
  assert.equal(mode==='dotted-key'?value:value.v,1);
 }else{
  for(const literal of ['9'.repeat(500000),'0x'+'f'.repeat(500000),'0o'+'7'.repeat(500000),'0b'+'1'.repeat(500000)])
   assert.throws(()=>toml.parse('v='+literal),/range|integer/i);
 }
 console.log('PASS');
`;
for(const mode of ['anchor-config','array-tables','dotted-key','table-path','integer-limits']){
 test('TOML security: '+mode,()=>{
  const child=spawnSync(process.execPath,['--max-old-space-size=128','-e',code,mode],{
   cwd:require('node:path').resolve(__dirname,'..'),encoding:'utf8',timeout:5000,maxBuffer:4096,windowsHide:true,
  });
  assert.ifError(child.error);
  assert.equal(child.status,0,child.stderr);
  assert.equal(child.stdout.trim(),'PASS');
 });
}
