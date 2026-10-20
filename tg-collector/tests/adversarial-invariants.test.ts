import assert from "node:assert/strict";
import {test} from "node:test";
import {extractLinks} from "../src/analytics/extract.js";
import {matchesSearchTerm} from "../src/runtime/message-search.js";
import {decodeMintAccount,TOKEN_PROGRAM,TOKEN_2022_PROGRAM} from "../src/analytics/solana-mint-layout.js";
import {classifyTelegramError} from "../src/queue/retry.js";

let seed=0x6b287e15;
function rnd(): number {
  seed ^= seed<<13;seed ^= seed>>>17;seed ^= seed<<5;
  return (seed>>>0)/0x100000000;
}
const alphabet="abCDEF_@$:/- .éЖ💎00112zx";
function input(n:number):string{
  let out="";
  for(let i=0;i<n;i++)out+=alphabet[Math.floor(rnd()*alphabet.length)];
  return out;
}

test("fuzz: 3,000 adversarial text/entity payloads produce deterministic, unique evidence",()=>{
  for(let i=0;i<3000;i++){
    const raw=input(Math.floor(rnd()*95))+(i%4===0?" @ExampleChannel":"")+
      (i%13===0?" https://t.me/PublicChannel":"");
    const entities=i%5===0?[{className:"MessageEntityTextUrl",url:"https://t.me/HiddenChannel"}]:[];
    const msg={id:i+1,message:raw,entities};
    const a=extractLinks(msg),b=extractLinks(msg);
    assert.deepEqual(a,b);
    assert.equal(new Set(a.map(x=>[x.kind,x.targetKind,x.targetKey].join(":"))).size,a.length);
    assert.ok(a.every(x=>x.targetKey.length>0));
    assert.deepEqual(a,[...a].sort((x,y)=>x.kind.localeCompare(y.kind)||
      x.targetKind.localeCompare(y.targetKind)||x.targetKey.localeCompare(y.targetKey)));
    if(i%4===0)assert.ok(a.some(x=>x.targetKind==="handle"&&x.targetKey==="examplechannel"));
    if(i%5===0)assert.ok(a.some(x=>x.targetKind==="handle"&&x.targetKey==="hiddenchannel"));
  }
});

test("fuzz: 1,500 search boundary/escaping variants never throw",()=>{
  const terms=["PNUT","$", ".","a+b","a[b","\u005c\u005c","😀","Привет","tokens","USDT"];
  for(let i=0;i<1500;i++){
    const term=terms[i%terms.length];
    const text=input(Math.floor(rnd()*170))+(i%3===0?" "+term+" ":"");
    const a=matchesSearchTerm(text,term);
    assert.equal(a,matchesSearchTerm(text,term));
    assert.equal(typeof a,"boolean");
  }
  assert.equal(matchesSearchTerm("PNUTabc","PNUT"),false);
  assert.equal(matchesSearchTerm("PNUT abc","PNUT"),true);
  assert.equal(matchesSearchTerm("XPNUT","PNUT"),false);
});

test("fuzz: 2,500 random account shapes never cross-accept invalid mint owners",()=>{
  const lengths=[0,1,81,82,83,164,165,166,170,500];
  for(let i=0;i<2500;i++){
    const bytes=Buffer.alloc(lengths[i%lengths.length]);
    for(let j=0;j<bytes.length;j++)bytes[j]=Math.floor(rnd()*256);
    assert.equal(decodeMintAccount("random_program",bytes),null);
    assert.equal(decodeMintAccount(TOKEN_PROGRAM,bytes)===null ||
      bytes.length===82,true);
    const accepted=decodeMintAccount(TOKEN_2022_PROGRAM,bytes);
    assert.ok(!accepted||bytes.length===82||bytes.length>=166);
  }
});

test("fuzz: retry policy always halts account restriction and delays known FloodWait",()=>{
  for(let i=1;i<=150;i++){
    const decision=classifyTelegramError(new Error("FLOOD_WAIT_"+i),i%4,()=>0);
    assert.equal(decision.action,"delay");
    if(decision.action==="delay"){
      assert.equal(decision.code,"TG_FLOOD_WAIT");
      assert.ok(decision.seconds>=i);
      assert.ok(decision.global);
    }
  }
  for(const reason of ["PEER_FLOOD","SESSION_REVOKED","AUTH_KEY_UNREGISTERED"]){
    assert.equal(classifyTelegramError(new Error(reason),1).action,"halt");
  }
});
