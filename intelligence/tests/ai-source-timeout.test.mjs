import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceQueryTimeout} from '../scripts/analyze-ai.mjs';

test('legacy source snapshots allow large real collector reads while normal reads stay bounded',()=>{
  assert.equal(sourceQueryTimeout({}),5000);
  assert.equal(sourceQueryTimeout({INTELLIGENCE_AI_SOURCE_SNAPSHOT_ENABLED:'true'}),120000);
  assert.equal(sourceQueryTimeout({INTELLIGENCE_AI_SOURCE_QUERY_TIMEOUT_MS:'60000'}),60000);
  for(const value of ['0','-1','Infinity','abc','300001','1.5'])
    assert.throws(()=>sourceQueryTimeout({INTELLIGENCE_AI_SOURCE_QUERY_TIMEOUT_MS:value}),/invalid_ai_source_query_timeout/);
});
