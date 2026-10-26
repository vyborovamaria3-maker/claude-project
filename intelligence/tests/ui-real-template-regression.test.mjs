import test from 'node:test';import assert from 'node:assert/strict';
import{isLowValueTelegramPost,isLowValueTwitterPost}from'../dist/index.js';
const mint='So11111111111111111111111111111111111111112';
const cards=[
`Call by @example - 3 calls - 4X\n\n🪙 Sample ($SAMPLE)\n└${mint}\n\n🏦 Market Cap: $12,000\n\nMake a call here 👉 @Solbix_bot\nTrade with Axiom and get a sample discount Here 👉 Axiom`,
`🚀 [New All-Time High] Token Alert!\n\nSample / $SAMPLE\n\nToken Contract: ${mint}\n\n💵 Current MC: $100K\n⏳ First Call MC: $10K\n📈 +900% since first call`,
`🔥 X2 profit reached for SAMPLE! (X4 from 💎VIP)\n\n${mint}\n\n📊Entry MC: 10K\n📊Current MC: 20K\n\n🟢Enable Auto Trading\n📈Statistic for the last 24 hours`,
`VIP Forward to display Winning - DO NOT BUY\n\n🪙 $SAMPLE\n\nEntry MC: 10K\n\n${mint}\n\n🌼 Call From: Example VIP`,
`📟$SAMPLE on SOL $10K mc\n\n${mint}\n\n🔋Score: 30/100\n├Risk Level: normal\n\n🔋BUY: Example\n\nAutomated by Token Ping\n➖️➖️➖️\n🏹 Robinhood calls only: here`,
`⚡️ Sample ｜ $SAMPLE\n\n🤴 CA: ${mint}\n\nMC: $10K | 2m\n\n🔒 Full metrics · contact @example\n\nAVE | GMGN (BOT) | TROJAN | BLOOM`
];
test('whole scanner, history-only, profit and affiliate templates excluded; explicit criticism preserved',()=>{
 for(const card of cards){assert.equal(isLowValueTelegramPost(card),true,card);for(const framing of ['I lost money on this scam. Never again.','Ага, очередная безопасная ракета. Не покупайте это.'])assert.equal(isLowValueTelegramPost(card+'\n'+framing),false);}
 assert.equal(isLowValueTelegramPost('Gamble Found!\n'+mint+'\nI lost money on this scam. Never again.'),false);
 assert.equal(isLowValueTelegramPost('Gamble Found!\n'+mint+'\nАга, снова безопасная ракета. Не покупайте это.'),false);
});
test('whole airdrop/DM campaigns excluded without swallowing commentary',()=>{
 const cards=[`🌴 Take a closer look at Sample and the $SAMPLE token. Explore its airdrop page, Solana memecoin culture and crypto with $SOL.\n\nCA=${mint}\n\nhttps://t.co/sample`,`🎯 Discover more about Sample and the $SAMPLE token! Browse the airdrop page and explore Solana memecoin crypto with $SOL.\n\nCA=${mint}\n\nhttps://t.co/sample`,`$SAMPLE is MOVING FAST! 🚀\n\nAped at just $10K MC on my Alpha TG, and now it's at $20K MC — a claimed 2x move!\n\nWant to catch plays early? DM me to join the TG and get access to upcoming calls.\n\nCA: ${mint}\n\n#SAMPLE https://t.co/sample`];
 for(const card of cards){assert.equal(isLowValueTwitterPost(card),true,card);assert.equal(isLowValueTwitterPost(card+'\nI did not buy. This claim is false.'),false);}
});
