import test from 'node:test';import assert from 'node:assert/strict';import{isLowValueTelegramPost}from'../dist/index.js';
const mint='So11111111111111111111111111111111111111112';
const launch=`⚡️ Example Club ｜ $TEST\n\n🤴 CA: ${mint}\n\nMC: $16.5k  | ⌛️ 13m`.replaceAll('\\n','\n');
const affiliate=`⭐ ALPHA · verified caller signal\n\n🟠 $CA-TEST\n\n💰 MCap  ·  ?\n⛓ Chain  ·  SOL\n\n${mint}\n\n⚡ Buy on Axiom  ·  10% off fees\n📱 FOMO Mobile  ·  one-tap buys\n\n━━━━━━━━━━━━━━━━━━\n⚡ Get calls INSTANTLY — no 60s delay\n👉 Join Premium`.replaceAll('\\n','\n');
test('complete compact launch and premium affiliate cards are excluded',()=>{assert.equal(isLowValueTelegramPost(launch),true);assert.equal(isLowValueTelegramPost(affiliate),true)});
test('human framing or qualifications around either card are retained',()=>{for(const card of[launch,affiliate]){assert.equal(isLowValueTelegramPost('I do not trust this claim.\n'+card),false);assert.equal(isLowValueTelegramPost(card+'\nI expect downside; liquidity is poor.'),false)}});
