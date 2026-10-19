import {test} from "node:test";import assert from "node:assert/strict";
import {extractTwitterKeywords} from "../src/runtime/twitter-keywords.js";
const options={limit:12,minPosts:3,minAuthors:2};
const rows=Array.from({length:6},(_,i)=>({tweet_id:String(i),handle:'author'+i%3,text:`$PEPE memecoin market update ${i} #Solana`}));
test('autokeywords rank tickers and topics by independent posts and authors',()=>{
 const words=extractTwitterKeywords(rows,options);assert.equal(words[0].keyword,'pepe');assert.ok(words.some(w=>w.keyword==='solana'));assert.equal(words[0].posts,6);assert.equal(words[0].authors,3);
 assert.equal(extractTwitterKeywords(rows,{...options,limit:1}).length,1);
});
test('copied text, one-author repetition, URLs, addresses and irrelevant tags do not become queries',()=>{
 assert.deepEqual(extractTwitterKeywords(rows.map(r=>({...r,text:'$PEPE memecoin buy now'})),options),[]);
 assert.deepEqual(extractTwitterKeywords(rows.map(r=>({...r,handle:'one_author'})),options),[]);
 assert.deepEqual(extractTwitterKeywords(rows.map((r,i)=>({...r,text:`#travel $USDT news ${i}`})),options),[]);
 assert.deepEqual(extractTwitterKeywords(rows.map((r,i)=>({...r,text:`Visit https://example.test/secret_${i} 0x1111111111111111111111111111111111111111`})),options),[]);
});
