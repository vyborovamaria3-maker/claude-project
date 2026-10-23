import {test} from 'node:test';
import assert from 'node:assert/strict';
import {safeDiagnostic} from '../lib/trade/safe-diagnostic';

test('CLI diagnostic never emits arbitrary exception, JSON parser input, or nested cause',()=>{
 const secret='synthetic-canary-do-not-log';
 for(const error of [secret, {message:secret},new Error(`Unexpected token in "${secret}"`),
   new Error('KEY_UNAVAILABLE '+secret),new Error(secret,{cause:new Error(secret)})]) {
  assert.equal(safeDiagnostic(error),'OPERATION_FAILED');
 }
 assert.equal(safeDiagnostic(new Error('KEY_UNAVAILABLE')),'KEY_UNAVAILABLE');
 assert.equal(safeDiagnostic(Object.assign(new Error(secret),{code:'23505'})),'PG_23505');
 assert.equal(safeDiagnostic(Object.assign(new Error(secret),{code:secret})),'OPERATION_FAILED');
});
