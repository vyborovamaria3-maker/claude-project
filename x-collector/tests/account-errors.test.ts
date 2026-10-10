import assert from 'node:assert/strict';
import {test} from 'node:test';
import {classifyError} from '../src/accounts/errors';
import {computeScore,type CheckSteps} from '../src/accounts/diagnostics';
test('account errors classify transport, session, block and rate limits',()=>{
 for(const [message,type] of [['AUTH_REQUIRED: login','SESSION_EXPIRED'],['net::ERR_PROXY_CONNECTION_FAILED','PROXY_FAILED'],['net::ERR_TUNNEL_CONNECTION_FAILED','PROXY_FAILED'],['X returned HTTP 429','RATE_LIMIT'],['captcha challenge','X_BLOCKED'],['browsermissing','BROWSER_ERROR'],['unknown','OTHER']])assert.equal(classifyError(Error(message)),type);
});
test('health score cannot report ready with an unverified required step',()=>{
 const steps=Object.fromEntries(['database','session','proxy','browser','x'].map(k=>[k,{status:'passed'}])) as CheckSteps;
 assert.deepEqual(computeScore(steps,true),{score:100,ready:true});
 steps.proxy.status='failed';assert.deepEqual(computeScore(steps,true),{score:85,ready:false});
 steps.proxy.status='skipped';assert.deepEqual(computeScore(steps,false),{score:100,ready:true});
 steps.x.status='failed';assert.deepEqual(computeScore(steps,false),{score:65,ready:false});
 for(const step of Object.values(steps))step.status='skipped';assert.deepEqual(computeScore(steps,false),{score:0,ready:false});
});
