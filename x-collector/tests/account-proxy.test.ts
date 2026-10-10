import assert from 'node:assert/strict';
import {test} from 'node:test';
import {normalizeProxy,serializeProxy,toPublicProxy} from '../src/accounts/proxy';
import {parseProxy} from '../src/x/proxy';
test('proxy formats converge, including encoded credentials and type alias',()=>{
 const expected={type:'socks5',host:'localhost',port:10808,username:'user',password:'p@ss'};
 for(const input of ['socks5://user:p%40ss@localhost:10808',JSON.stringify({server:'socks5://user:p%40ss@localhost:10808'}),{type:'socks5',host:'localhost',port:10808,username:'user',password:'p@ss'},{protocol:'socks5',host:'localhost',port:'10808',username:'user',password:'p@ss'}]){
  assert.deepEqual(normalizeProxy(input),expected);
  assert.deepEqual(normalizeProxy(serializeProxy(input)),expected);
  assert.deepEqual(parseProxy(typeof input==='string'?input:JSON.stringify(input)),{server:'socks5://localhost:10808',username:'user',password:'p@ss'});
 }
 assert.equal(normalizeProxy(null),null);
 assert.equal(normalizeProxy('localhost:10809')?.type,'http');
});
test('invalid proxy never accepted and public projection does not leak secrets',()=>{
 for(const input of ['ftp://host:2','http://host:70000','http://host:4/path',{},'http://user:%ZZ@host:4'])assert.throws(()=>normalizeProxy(input));
 const projection=toPublicProxy(JSON.stringify({server:'http://user:secret@localhost:10809',password:'secret',ip:'1.2.3.4',arbitrarySecret:'private',status:'connected'}));
 assert.equal(projection?.hasPassword,true);assert.equal(projection?.ipMasked,'1.2.*.*');
 assert.ok(!JSON.stringify(projection).includes('secret'));assert.ok(!JSON.stringify(projection).includes('private'));
 assert.equal(parseProxy('not a proxy'),undefined);
});

test('IPv6 endpoints preserve brackets and IPv6 egress is masked',()=>{
 const url='http://user:p%40ss@[2001:db8::1]:8080';
 assert.deepEqual(normalizeProxy(url),normalizeProxy({type:'http',host:'2001:db8::1',port:8080,username:'user',password:'p@ss'}));
 assert.equal(parseProxy(url)?.server,'http://[2001:db8::1]:8080');
 const result=toPublicProxy({...normalizeProxy(url),ip:'2001:db8:abcd::1234'});
 assert.equal(result?.ipVersion,6);assert.equal(result?.ipMasked,'2001:db8:*');
 assert.ok(!JSON.stringify(result).includes('p@ss'));
});
