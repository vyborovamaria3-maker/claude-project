const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const code=String.raw`
 const assert=require('node:assert/strict'),{createRequire}=require('node:module');
 const {Address4,Address6}=createRequire(process.argv[1])('ip-address');
 if(process.argv[2]==='normal'){
  assert(Address4.isValid('127.0.0.1'));
  assert.equal(new Address4('192.0.2.1/24').subnetMask,24);
  assert(Address6.isValid('2001:db8::1/64'));
  const scoped=new Address6('fe80::1%eth0');
  assert.equal(scoped.zone,'%eth0');assert.equal(scoped.correctForm(),'fe80::1');
  assert.equal(Address6.fromByteArray([...Array(15).fill(0),1]).correctForm(),'::1');
 }else{
  for(const terminator of ['\n','\r','\u2028','\u2029']){
   const input='%'.repeat(500000)+terminator;
   assert.equal(Address6.isValid(input),false);
   assert.throws(()=>new Address6(input));
  }
 }
 console.log('PASS');
`;
// Both installed consumers resolve the patched parser; no proxy or HTTP connection.
for(const consumer of ['socks','express-rate-limit'])for(const mode of ['normal','zone-DoS']){
 test('ip-address: '+consumer+' '+mode,()=>{
  const child=spawnSync(process.execPath,['--max-old-space-size=64','-e',code,require.resolve(consumer),mode],{
   encoding:'utf8',timeout:3000,maxBuffer:4096,windowsHide:true,
  });
  assert.ifError(child.error);assert.equal(child.status,0,child.stderr);
  assert.equal(child.stdout.trim(),'PASS');
 });
}
