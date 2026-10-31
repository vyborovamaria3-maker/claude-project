import test from 'node:test';
import assert from 'node:assert/strict';
import {tokenFailureDiagnostic} from '../api/token-failure-diagnostic.mjs';
test('failure diagnostics preserve known cause without source text, keys, DSNs or arbitrary errors',()=>{
 for(const code of ['ai_provider_timeout','ai_provider_network_error','57014','ECONNREFUSED']){
  assert.deepEqual(tokenFailureDiagnostic({code,message:'Bearer PRIVATE',source:'PRIVATE',stack:'PRIVATE'},60123.4),{event:'token_analysis_failed',code,elapsedMs:60123});
 }
 for(const error of [null,undefined,'PRIVATE',{code:'PRIVATE',message:'PRIVATE'}])assert(!JSON.stringify(tokenFailureDiagnostic(error,5)).includes('PRIVATE'));
});
