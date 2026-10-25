import assert from "node:assert/strict";
import {test} from "node:test";
import {assessPromotionalChannel,promotionalScreeningEnabled,promotionalMilestoneKind,PROMO_SAMPLE_LIMIT} from "../src/analytics/promo-spam.js";

const axiosExamples=[
["14.9","7","227.24"],["12.9","6","197.38"],["10.9","5","166.79"],
["9.1","4","139.53"],["6.9","3","106.20"],["5.2","2","79.52"],
["25.6","12","391.84"],["23.4","11","357.21"],["22.1","10","338.16"],
["20.2","9","308.90"],["17.5","8","266.96"],["36.3","17","554.87"],
["32.4","15","494.89"],["29.6","14","452.94"],["27.5","13","420.98"],
].map(([vip,growth,mc],i)=>({
 id:2000+i,
 message:`#PNUT · VIP: x${vip} ├ 🚀 Growth: x${growth} ├ 📊 MC: $31.97K → $${mc}K ⏱️4h 28m └ 🟢 DEX PAID ⭐ Get VIP access ⭐`,
}));
const news=(id:number)=>({id,message:`Real channel announcement ${id}: an independent on-chain investigation`});

test("axioscan June 2026 paid VIP milestones are recognized",()=>{
  for(const post of axiosExamples) assert.equal(promotionalMilestoneKind(post.message),
    "promotional_milestone");
  const sample=[...axiosExamples,...Array.from({length:105},(_,i)=>news(i+1))];
  const verdict=assessPromotionalChannel(sample);
  assert.deepEqual(verdict,{
    inspected:120,matches:15,repeatedTicker:"PNUT",spam:true,
  });
  assert.equal(PROMO_SAMPLE_LIMIT,120);
});

test("one paid post among normal news never blocks entire channel",()=>{
  const posts=[axiosExamples[0],...Array.from({length:119},(_,i)=>news(i+1))];
  assert.deepEqual(assessPromotionalChannel(posts),{
    inspected:120,matches:1,repeatedTicker:null,spam:false,
  });
});

test("noisy distinct tickers do not trigger same-token campaign rule",()=>{
  const posts=Array.from({length:120},(_,i)=>i<20
    ? {id:i+1,message:axiosExamples[0].message.replace("#PNUT",`#P${String(i).padStart(3,"0")}`)}
    : news(i+1));
  const r=assessPromotionalChannel(posts);
  assert.equal(r.matches,20);
  assert.equal(r.repeatedTicker,null);
  assert.equal(r.spam,false);
});

test("non-advertising PNUT signals, ROI research and token warnings are retained",()=>{
  for(const text of [
    "$PNUT liquidity changed and 120 wallets bought in 30 minutes",
    "#PNUT MC: $31.97K → $227.24K; verified token analyst commentary",
    "#PNUT VIP: x14.9 Growth: x7 MC: $31K → $200K (no paid promotion)",
    "PNUT volatility analysis, early call and risks",
    "#PNUT #BONK watchlist and Binance listing news",
  ]) assert.equal(promotionalMilestoneKind(text),null,text);
});

test("few identical posts or short channels do not overblock",()=>{
  const withDuplicates=Array.from({length:60},(_,i)=>({...axiosExamples[i%15]}));
  const a=assessPromotionalChannel([...withDuplicates,...Array.from({length:60},(_,i)=>news(i+1))]);
  assert.equal(a.inspected,75);
  assert.equal(a.matches,15);
  assert.equal(a.spam,true);
  const small=assessPromotionalChannel(axiosExamples.slice(0,10));
  assert.equal(small.spam,false,"sample smaller than 12 should be re-screened later");
});

test("automatic screening is explicit opt-in only",()=>{
 assert.equal(promotionalScreeningEnabled({}),false);
 assert.equal(promotionalScreeningEnabled({TG_PROMOTIONAL_SCREENING_ENABLED:"false"}),false);
 assert.equal(promotionalScreeningEnabled({TG_PROMOTIONAL_SCREENING_ENABLED:"1"}),false);
 assert.equal(promotionalScreeningEnabled({TG_PROMOTIONAL_SCREENING_ENABLED:"true"}),true);
});
