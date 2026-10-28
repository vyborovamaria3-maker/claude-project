import test from'node:test';import assert from'node:assert/strict';import{isLowValueTelegramPost,isLowValueTwitterPost}from'../dist/index.js';
const mint='So11111111111111111111111111111111111111112';
test('complete automated Token Ping and discovery ads are excluded without swallowing surrounding discussion',()=>{
 const tg=`📟$EXAMPLE on SOL $1M mc\n\n‎${mint}‎\n\n🔋Score: 62/100\n├Risk Level: normal\n\n🔋BUY: GMGN •Axiom\n├Scan: DexS\n\nAutomated by Token Ping\n➖️➖️➖️\n⭐️How to trade on #ROBINHOOD chain 👉 here ⭐️`;
 const x=`🔥 Meet EXAMPLE: its $EXAMPLE token appears in the Solana memecoin scene. Discover the airdrop page and explore crypto with $SOL.\n\nCA=${mint}\n\nhttps://example.test/card`;
 const fib=`${mint}\n├ Token: $EXAMPLE\n\nTOKEN DATA\nPrice: 1\nVolume: 2\n\nFIB ZONES\n.618 3\n\nTrade: FOMO | AXIOM\nScan: OCC | Chart\n\nWant to see detailed wallet breakdown? Join Private Channel →`;
 for(const[filter,card]of[[isLowValueTelegramPost,tg],[isLowValueTwitterPost,x],[isLowValueTelegramPost,fib]]){
  assert.equal(filter(card),true);
  assert.equal(filter(card+'\nThose safety claims are false; I would not buy.'),false);
  assert.equal(filter('I do not trust this card.\n'+card),false);
 }
 for(const text of ['This looks like the reverse of a collapse, though I am unsure. ','Do not buy first; try the product and decide. ','Nobody promised safety; do not ignore that qualification. '])assert.equal(isLowValueTelegramPost(text+mint),false);
});
