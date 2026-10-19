import {test} from 'node:test';import assert from 'node:assert/strict';
import {pumpToken,tweetPumpMints} from '../src/runtime/pump-keywords.js';
const mint='11111111111111111111111111111111pump';
test('Pump ATH requires historical value and keeps case-sensitive mint',()=>{
 assert.equal(pumpToken({mint,symbol:'PEPE',usd_market_cap:500000},100000),null);
 assert.equal(pumpToken({mint,symbol:'PEPE',ath_market_cap:99999},100000),null);
 assert.equal(pumpToken({mint,symbol:'PEPE',ath_market_cap:100000},100000)?.mint,mint);
 assert.equal(pumpToken({mint:'invalid',symbol:'PEPE',ath_market_cap:200000},100000),null);
 assert.deepEqual(tweetPumpMints(['check '+mint,mint],3),[mint]);
});
