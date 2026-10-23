"use strict";
const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const WXMR = "WXMRyRZhsa19ety5erZhHg4N3xj3EVN92u94422teJp";
const SOL = "So11111111111111111111111111111111111111112";
const TOKEN_PROGRAMS = new Set(["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]);
const DISCRIMINATOR = Buffer.from("bddb7fd34ee661ee", "hex");
function base58(bytes) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = BigInt("0x" + bytes.toString("hex")), result = "";
  while (value) { result = alphabet[Number(value % 58n)] + result; value /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; result = "1" + result; }
  return result;
}
// Stable TradeEvent prefix from pump-fun/pump-public-docs/idl/pump.json.
// Only accept data emitted while the canonical Pump program is executing.
function pumpEvents(raw) {
  const events = [], stack = [];
  for (const line of raw?.meta?.logMessages || []) {
    const invoke = /^Program (\w+) invoke \[(\d+)\]$/.exec(line);
    if (invoke) { stack.length = Number(invoke[2]) - 1; stack.push(invoke[1]); continue; }
    const exit = /^Program (\w+) (?:success|failed:.*)$/.exec(line);
    if (exit) { if (stack.at(-1) !== exit[1]) return []; stack.pop(); continue; }
    if (stack.at(-1) !== PUMP || !line.startsWith("Program data: ")) continue;
    const bytes = Buffer.from(line.slice(14), "base64");
    if (!bytes.subarray(0, 8).equals(DISCRIMINATOR)) continue;
    if (bytes.length < 129 || bytes[56] > 1) return [];
    events.push({ mint: base58(bytes.subarray(8, 40)), solRaw: bytes.readBigUInt64LE(40),
      tokenRaw: bytes.readBigUInt64LE(48), buy: bytes[56] === 1,
      protocolUser: base58(bytes.subarray(57, 89)) });
  }
  return events;
}
function tokenAccounts(tx, mint) {
  const map = new Map();
  for (const entry of [...(tx.raw.meta.preTokenBalances || []), ...(tx.raw.meta.postTokenBalances || [])]) {
    const key = tx.accountKeys?.[entry.accountIndex];
    if (key && entry.mint === mint && entry.owner) map.set(key, entry.owner);
  }
  // Closed temporary quote accounts have no pre/post token-balance row.
  // Retain explicit SPL initialization ownership to prove wrapped-SOL settlement.
  const instructions = [...(tx.raw.transaction.message.instructions || []),
    ...(tx.raw.meta.innerInstructions || []).flatMap(g => g.instructions)];
  for (const ix of instructions) {
    const info = ix.parsed?.info;
    if (TOKEN_PROGRAMS.has(ix.programId) && ["initializeAccount", "initializeAccount2", "initializeAccount3"].includes(ix.parsed?.type)
        && info?.mint === mint && typeof info.owner === "string" && typeof info.account === "string") {
      if (map.has(info.account) && map.get(info.account) !== info.owner) return new Map();
      map.set(info.account, info.owner);
    }
  }
  return map;
}
function hasPath(edges, starts, ends, ownerByAccount, protocolUser) {
  // An exact-amount checked-transfer chain must cross the protocol's user account.
  const visit = (node, seen, includesUser, after = -1) => {
    const user = includesUser || ownerByAccount.get(node) === protocolUser;
    if (ends.has(node) && seen.size > 1) return user;
    if (seen.size > 8) return false;
    return edges.some((e,index) => index > after && e.source === node && !seen.has(e.destination)
      && visit(e.destination, new Set([...seen, e.destination]), user, index));
  };
  return [...starts].some(start => visit(start, new Set([start]), false));
}
// Checked/unchecked SPL cash flows, resolved from transaction account metadata.
function cashFlow(tx, instructions, mint, owner) {
  const owners = tokenAccounts(tx, mint);
  let delta = 0n;
  for (const ix of instructions) {
    if (!TOKEN_PROGRAMS.has(ix.programId)) continue;
    const info = ix.parsed?.info;
    if (!info || !["transfer", "transferChecked"].includes(ix.parsed.type)) continue;
    if (ix.parsed.type === "transferChecked" ? info.mint !== mint : !owners.has(info.source) && !owners.has(info.destination)) continue;
    const amount = info.tokenAmount?.amount ?? info.amount;
    if (!/^\d+$/.test(String(amount))) return null;
    if (owners.get(info.source) === owner) delta -= BigInt(amount);
    if (owners.get(info.destination) === owner) delta += BigInt(amount);
  }
  return delta;
}
function instructionBytes(data) {
  if (typeof data !== "string" || data.length > 100) return null;
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const c of data) { const v = alphabet.indexOf(c); if (v < 0) return null; n = n * 58n + BigInt(v); }
  let hex = n.toString(16); if (hex.length % 2) hex = "0" + hex;
  return Buffer.from(hex, "hex");
}
function routePrefix(data) {
  const bytes=instructionBytes(data); if(!bytes)return "";
  const prefix=bytes.subarray(0,8).toString("hex");
  return (bytes.length===57&&prefix==="aa2955b184501f35")||(bytes.length===56&&prefix==="be9ca9b0959aa16c")?prefix:"";
}
function containsPump(tx,group) {
  return tx.raw.transaction.message.instructions[group.index]?.programId===PUMP || group.instructions.some(ix=>ix.programId===PUMP);
}
function splitBuy(tx, mint, event, deltas, signers) {
  if (!event.buy || ![3,4].includes(deltas.length)) return null;
  const negative = deltas.filter(d => BigInt(d.deltaRaw) < 0n), positive = deltas.filter(d => BigInt(d.deltaRaw) > 0n);
  if (negative.length !== 1 || ![2,3].includes(positive.length) || BigInt(negative[0].deltaRaw) !== -event.tokenRaw
      || positive.reduce((n,d) => n + BigInt(d.deltaRaw), 0n) !== event.tokenRaw) return null;
  const owners = tokenAccounts(tx, mint), matches = [];
  for (const group of tx.raw.meta.innerInstructions || []) {
    if(!containsPump(tx,group))continue;
    const ix = tx.raw.transaction.message.instructions[group.index], a = ix?.accounts;
    // Pin the observed canonical router SwapTob ABI; never select the largest recipient.
    if (ix?.programId !== "proVF4pMXVaYqmy4NjniPh4pqKNfMmsihgd4wdkCX3u" || !["aa2955b184501f35","be9ca9b0959aa16c"].includes(routePrefix(ix.data))
        || !a || a[4] !== mint || !signers.has(a[0])) continue;
    const quoteOwners = tokenAccounts(tx, a[3]);
    if (quoteOwners.get(a[1]) !== a[0]) continue;
    const trader = positive.find(d => d.owner === owners.get(a[2]));
    if (!trader) continue;
    const transfers = group.instructions.filter(x => TOKEN_PROGRAMS.has(x.programId) && x.parsed?.type === "transferChecked"
      && x.parsed.info.mint === mint).map(x => x.parsed.info);
    if (transfers.length !== positive.length + 1) continue;
    const [input, ...outputs] = transfers;
    if (owners.get(input.source) !== negative[0].owner || owners.get(input.destination) !== event.protocolUser
        || input.tokenAmount.amount !== String(event.tokenRaw)) continue;
    if (!outputs.every(o => o.source === input.destination && o.authority === event.protocolUser
      && positive.some(d => d.owner === owners.get(o.destination) && d.deltaRaw === o.tokenAmount.amount))) continue;
    if (new Set(outputs.map(o=>o.destination)).size !== positive.length
        || new Set(outputs.map(o=>owners.get(o.destination))).size !== positive.length
        || !outputs.some(o => o.destination === a[2])) continue;
    if (outputs.reduce((n,o)=>n+BigInt(o.tokenAmount.amount),0n) !== event.tokenRaw) continue;
    const deductions = positive.filter(d => d.owner !== trader.owner);
    matches.push({ trader, pool: negative[0], group, quoteOwner: a[0], quoteMint: a[3],
      tokenDeductions: deductions.map(d => ({owner:d.owner,amountRaw:d.deltaRaw})), grossTokenAmountRaw: String(event.tokenRaw) });
  }
  return matches.length === 1 ? matches[0] : null;
}
// A single recipient can be proven directly from an exact two-hop transfer,
// without interpreting an unpinned router ABI or choosing the largest wallet.
function forwardedBuy(tx,mint,event,deltas,signers) {
  if (!event.buy || deltas.length !== 2 || !signers.has(event.protocolUser)) return null;
  const trader=deltas.find(d=>BigInt(d.deltaRaw)===event.tokenRaw);
  const pool=deltas.find(d=>BigInt(d.deltaRaw)===-event.tokenRaw);
  if(!trader || !pool || trader.owner===event.protocolUser) return null;
  const owners=tokenAccounts(tx,mint), matches=[];
  for(const group of tx.raw.meta.innerInstructions||[]) {
    if(!containsPump(tx,group))continue;
    const transfers=group.instructions.filter(ix=>TOKEN_PROGRAMS.has(ix.programId)&&ix.parsed?.type==='transferChecked'&&ix.parsed.info.mint===mint).map(ix=>ix.parsed.info);
    if(transfers.length!==2)continue;
    const [a,b]=transfers;
    if(owners.get(a.source)!==pool.owner || owners.get(a.destination)!==event.protocolUser || a.destination!==b.source
      || b.authority!==event.protocolUser || owners.get(b.destination)!==trader.owner
      || a.tokenAmount.amount!==String(event.tokenRaw) || b.tokenAmount.amount!==String(event.tokenRaw))continue;
    matches.push({trader,pool,group,quoteOwner:event.protocolUser,tokenDeductions:[],grossTokenAmountRaw:String(event.tokenRaw),forwarded:true});
  }
  return matches.length===1?matches[0]:null;
}

function wxmrRoute(tx,mint,owner,buy,pumpGroups,poolOwner) {
  const all=[...tx.raw.transaction.message.instructions,...(tx.raw.meta.innerInstructions||[]).flatMap(g=>g.instructions)];
  const actual=(tx.tokenBalanceDeltas||[]).find(d=>d.owner===owner&&d.mint===WXMR)?.deltaRaw||'0';
  if(cashFlow(tx,all,WXMR,owner)!==BigInt(actual)) return null;
  const sum=(groups,currency)=>groups.reduce((n,g)=>{const f=cashFlow(tx,g.instructions,currency,owner);return f===null||n===null?null:n+f},0n);
  let groups=pumpGroups;
  const pumpFlow=sum(groups,WXMR); if(pumpFlow===null)return null;
  const wxmrOwners=tokenAccounts(tx,WXMR);
  let protocolFlow=0n;
  for(const ix of pumpGroups.flatMap(g=>g.instructions)) {
    const i=ix.parsed?.info;
    if(!TOKEN_PROGRAMS.has(ix.programId)||ix.parsed?.type!=='transferChecked'||i.mint!==WXMR)continue;
    if(wxmrOwners.get(i.source)===poolOwner&&wxmrOwners.get(i.destination)===owner)protocolFlow+=BigInt(i.tokenAmount.amount);
    if(wxmrOwners.get(i.source)===owner&&wxmrOwners.get(i.destination)===poolOwner)protocolFlow-=BigInt(i.tokenAmount.amount);
  }
  const ownerAccounts=tokenAccounts(tx,WXMR);
  const touched=g=>new Set(g.instructions.flatMap(ix=>{
    const i=ix.parsed?.info;
    if(!TOKEN_PROGRAMS.has(ix.programId)||!['transfer','transferChecked'].includes(ix.parsed?.type)||!i)return [];
    if(ix.parsed.type==='transferChecked'&&i.mint!==WXMR)return [];
    return [i.source,i.destination].filter(a=>ownerAccounts.get(a)===owner);
  }));
  const pumpAccounts=new Set(groups.flatMap(g=>[...touched(g)]));
  const candidates=(tx.raw.meta.innerInstructions||[]).filter(g=>!groups.includes(g)).filter(g=>{
    if(buy ? g.index>=Math.min(...groups.map(g=>g.index)) : g.index<=Math.max(...groups.map(g=>g.index)))return false;
    const f=cashFlow(tx,g.instructions,WXMR,owner);
    const currencies=[SOL,...(tx.preTokenBalances||[]).map(b=>b.mint),...(tx.postTokenBalances||[]).map(b=>b.mint)].filter(m=>m!==mint&&m!==WXMR);
    const conversion=currencies.some(m=>{const q=cashFlow(tx,g.instructions,m,owner);return q!==null&&(buy?q<0n:q>0n)});
    return conversion&&f!==null&&(buy?f>0n&&pumpFlow<0n:f<0n&&pumpFlow>0n)&&[...touched(g)].some(a=>pumpAccounts.has(a));
  });
  if(candidates.length>1)return null;
  if(candidates.length===1) {
    groups=[...groups,candidates[0]].sort((a,b)=>a.index-b.index);
    if(sum(groups,WXMR)!==BigInt(actual))return null;
  }
  const currencies=[...new Set([SOL,...(tx.preTokenBalances||[]).map(b=>b.mint),...(tx.postTokenBalances||[]).map(b=>b.mint)])].filter(m=>m!==mint&&m!==WXMR);
  let settlement=currencies.filter(m=>{const f=sum(groups,m);return f!==null&&(buy?f<0n:f>0n)});
  if(settlement.length>1) {
    const balanced=settlement.filter(m=>(tx.tokenBalanceDeltas||[]).some(d=>d.owner===owner&&d.mint===m&&(buy?BigInt(d.deltaRaw)<0n:BigInt(d.deltaRaw)>0n)));
    if(balanced.length===1)settlement=balanced;
  }
  // Token quote is intermediate only with both a credit and a debit on an
  // explicitly owned WXMR account. Retain any residual rather than rounding it.
  const instructions=groups.flatMap(g=>g.instructions);
  let credit=0n,debit=0n;
  for(const ix of instructions){const f=cashFlow(tx,[ix],WXMR,owner);if(f===null)return null;if(f>0n)credit+=f;else debit-=f}
  const direct=()=> {
    if(buy?pumpFlow<0n:pumpFlow>0n)return {groups:pumpGroups,currency:WXMR,intermediateDeltaRaw:actual};
    if(buy?protocolFlow<0n:protocolFlow>0n)return {groups:pumpGroups,currency:WXMR,intermediateDeltaRaw:actual,protocolWxmrFlow:protocolFlow};
    return {groups:pumpGroups};
  };
  if(settlement.length===0) return candidates.length ? null : direct();
  // A partial conversion leaves two assets. Keep the complete protocol quote
  // instead of presenting just the converted fraction as the trade proceeds.
  if(candidates.length && BigInt(actual)!==0n)return direct();
  if(BigInt(actual)<0n)return direct();
  if(settlement.length!==1 || credit<=0n || debit<=0n)return candidates.length?null:direct();
  return {groups,currency:settlement[0],intermediateDeltaRaw:actual,conversionGroup: candidates[0]?.index??null};
}

const ORDER_PROGRAM='6Vo3245eszAb5wuqEMw8mGdbfRUdKbHhDHP5LcaGuTAB';
const USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
function decodeLimitOrderSell(tx,mint,event,deltas,signers) {
  if(event.buy || deltas.length!==2)return null;
  const custody=deltas.find(d=>BigInt(d.deltaRaw)===-event.tokenRaw&&d.owner===event.protocolUser);
  const pool=deltas.find(d=>BigInt(d.deltaRaw)===event.tokenRaw);
  if(!custody||!pool||signers.has(custody.owner)||!Number.isInteger(custody.decimals)||custody.decimals<0||custody.decimals>18)return null;
  if([...tx.preTokenBalances,...tx.postTokenBalances].some(b=>(b.mint===USDC&&b.uiTokenAmount?.decimals!==6)||(b.mint===WXMR&&b.uiTokenAmount?.decimals!==12)))return null;
  const matches=[],targetOwners=tokenAccounts(tx,mint),quoteOwners=tokenAccounts(tx,USDC),wxmrOwners=tokenAccounts(tx,WXMR);
  const all=[...tx.raw.transaction.message.instructions,...(tx.raw.meta.innerInstructions||[]).flatMap(g=>g.instructions)];
  const delta=(owner,currency)=>BigInt((tx.tokenBalanceDeltas||[]).find(d=>d.owner===owner&&d.mint===currency)?.deltaRaw||'0');
  for(const group of tx.raw.meta.innerInstructions||[]) {
    const outer=tx.raw.transaction.message.instructions[group.index],a=outer?.accounts,bytes=instructionBytes(outer?.data);
    // Observed ExecuteLimitOrder ABI: executor, beneficiary, input/output
    // mints, custody authority, custody accounts and beneficiary destination.
    if(outer?.programId!==ORDER_PROGRAM||!bytes||bytes.length!==65||bytes.subarray(0,8).toString('hex')!=='34213c1e2f642816'
      ||!a||a.length<18||!signers.has(a[0])||a[1]===a[0]||a[1]===custody.owner
      ||a[2]!==mint||a[7]!==mint||a[3]!==USDC||a[9]!==USDC||a[6]!==custody.owner
      ||targetOwners.get(a[8])!==custody.owner||quoteOwners.get(a[10])!==custody.owner
      ||quoteOwners.get(a[11])!==a[1]||targetOwners.get(a[12])!==a[1]||!containsPump(tx,group))continue;
    const ix=group.instructions;
    const transfers=ix.filter(x=>TOKEN_PROGRAMS.has(x.programId)&&x.parsed?.type==='transferChecked'&&x.parsed.info.mint===mint).map(x=>x.parsed.info);
    if(transfers.length!==1)continue;
    const input=transfers[0];
    if(input.source!==a[8]||input.authority!==custody.owner||targetOwners.get(input.destination)!==pool.owner||input.tokenAmount.amount!==String(event.tokenRaw)||input.tokenAmount.decimals!==custody.decimals)continue;
    if(cashFlow(tx,all,mint,custody.owner)!==-event.tokenRaw)continue;
    const checked=ix.filter(x=>TOKEN_PROGRAMS.has(x.programId)&&x.parsed?.type==='transferChecked').map(x=>x.parsed.info);
    const received=checked.filter(i=>i.mint===WXMR&&wxmrOwners.get(i.source)===pool.owner&&wxmrOwners.get(i.destination)===custody.owner);
    const spent=checked.filter(i=>i.mint===WXMR&&wxmrOwners.get(i.source)===custody.owner&&wxmrOwners.get(i.destination)!==custody.owner);
    if(received.length!==1||spent.length!==1||received[0].tokenAmount.amount!==spent[0].tokenAmount.amount||checked.indexOf(received[0])>=checked.indexOf(spent[0]))continue;
    const quoteIn=checked.filter(i=>i.mint===USDC&&i.destination===a[10]&&quoteOwners.get(i.source)===wxmrOwners.get(spent[0].destination));
    if(quoteIn.length!==1||checked.indexOf(spent[0])>=checked.indexOf(quoteIn[0]))continue;
    const out=ix.filter(x=>TOKEN_PROGRAMS.has(x.programId)&&['transfer','transferChecked'].includes(x.parsed?.type)&&x.parsed.info.source===a[10]).map(x=>x.parsed.info);
    const amount=i=>BigInt(i.tokenAmount?.amount??i.amount);
    if(out.length!==2||!out.every(i=>i.authority===custody.owner))continue;
    const net=out.find(i=>i.destination===a[11]),fee=out.find(i=>quoteOwners.get(i.destination)===a[0]);
    if(!net||!fee||net===fee||amount(net)<=0n||amount(fee)<=0n||amount(net)+amount(fee)!==amount(quoteIn[0]))continue;
    if(amount(net)>BigInt(Number.MAX_SAFE_INTEGER)||custody.decimals<0||custody.decimals>18)continue;
    if(delta(custody.owner,WXMR)!==0n||delta(custody.owner,USDC)!==0n
      ||cashFlow(tx,all,WXMR,custody.owner)!==0n||cashFlow(tx,all,USDC,custody.owner)!==0n
      ||delta(a[1],USDC)!==amount(net)||cashFlow(tx,all,USDC,a[1])!==amount(net)
      ||delta(a[0],USDC)!==amount(fee)||cashFlow(tx,all,USDC,a[0])!==amount(fee))continue;
    // Do not infer any SOL price from the pool's zero legacy SOL field.
    matches.push({signature:tx.signature,timestamp:tx.timestamp,slot:tx.slot,trader:a[1],type:'sell',
      amountTokens:Number(event.tokenRaw)/10**custody.decimals,amountSol:0,priceSol:0,
      quoteMint:USDC,quoteDecimals:6,quoteAmount:Number(amount(net))/1e6,quoteAmountRaw:String(amount(net)),
      fee:Number(tx.raw.meta.fee||0)/1e9,feeLamports:Number(tx.raw.meta.fee||0),feePayer:a[0],source:'alchemy',decoderCoverage:'swap_only',
      attribution:'limit_order_beneficiary_and_custody_transfer',custodyOwner:custody.owner,executedBy:a[0],protocolTrader:event.protocolUser,
      settlementGrossRaw:String(amount(quoteIn[0])),settlementDeductions:[{owner:a[0],quoteMint:USDC,amountRaw:String(amount(fee))}],
      quoteWalletDeltaRaw:String(amount(net)),quoteRouteDeltaRaw:String(amount(net)),quoteExternalDeltaRaw:'0',
      orderProgram:ORDER_PROGRAM,orderInstructionGroup:group.index});
  }
  return matches.length===1?matches[0]:null;
}
function classifyIntermediatePumpSell(tx,mint) {
  if(tx?.transactionError!==null||tx.raw?.meta?.err!==null||tx.raw.transaction?.signatures?.[0]!==tx.signature)return null;
  const events=pumpEvents(tx.raw);
  if(events.length!==2||events[0].buy||events[1].buy||events[1].mint!==mint||events[0].mint===mint||events[0].protocolUser!==events[1].protocolUser)return null;
  const user=events[0].protocolUser,signers=new Set(tx.raw.transaction.message.accountKeys.filter(k=>k.signer===true).map(k=>k.pubkey));
  if(!signers.has(user))return null;
  const target=(tx.tokenBalanceDeltas||[]).filter(d=>d.mint===mint&&d.deltaRaw!=='0');
  if(target.length!==2)return null;
  const source=target.find(d=>BigInt(d.deltaRaw)===-events[1].tokenRaw),pool=target.find(d=>BigInt(d.deltaRaw)===events[1].tokenRaw);
  if(!source||!pool||source.owner===user||pool.owner===user||signers.has(source.owner))return null;
  // Verify pool identity rather than merely labelling a non-signing owner.
  try {
    const {PublicKey}=require('@solana/web3.js');
    const curve=m=>PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'),new PublicKey(m).toBuffer()],new PublicKey(PUMP))[0].toBase58();
    if(curve(events[0].mint)!==source.owner||curve(mint)!==pool.owner)return null;
  }catch{return null;}
  const upstream=events[0],inDelta=(tx.tokenBalanceDeltas||[]).filter(d=>d.mint===upstream.mint&&d.deltaRaw!=='0');
  if(inDelta.length!==2||!inDelta.some(d=>d.owner===user&&BigInt(d.deltaRaw)===-upstream.tokenRaw)
    ||!inDelta.some(d=>d.owner===source.owner&&BigInt(d.deltaRaw)===upstream.tokenRaw))return null;
  const targetOwners=tokenAccounts(tx,mint),upstreamOwners=tokenAccounts(tx,upstream.mint),matches=[];
  for(const group of tx.raw.meta.innerInstructions||[]) {
    const outer=tx.raw.transaction.message.instructions[group.index],bytes=instructionBytes(outer?.data);
    if(outer?.programId!==ORDER_PROGRAM||!bytes||bytes.length!==68||bytes.subarray(0,8).toString('hex')!=='be8efb768a255abd'||!containsPump(tx,group))continue;
    const transfers=group.instructions.filter(x=>TOKEN_PROGRAMS.has(x.programId)&&x.parsed?.type==='transferChecked').map(x=>x.parsed.info);
    const input=transfers.filter(i=>i.mint===upstream.mint&&i.authority===user&&upstreamOwners.get(i.source)===user&&upstreamOwners.get(i.destination)===source.owner&&i.tokenAmount.amount===String(upstream.tokenRaw));
    const intermediate=transfers.filter(i=>i.mint===mint&&i.authority===source.owner&&targetOwners.get(i.source)===source.owner&&targetOwners.get(i.destination)===pool.owner&&i.tokenAmount.amount===String(events[1].tokenRaw));
    if(input.length!==1||intermediate.length!==1||transfers.indexOf(input[0])>=transfers.indexOf(intermediate[0]))continue;
    matches.push({signature:tx.signature,mint,classification:'intermediate_pool_leg',initiator:user,sourcePool:source.owner,targetPool:pool.owner,
      soldInputMint:upstream.mint,soldInputAmountRaw:String(upstream.tokenRaw),intermediateAmountRaw:String(events[1].tokenRaw),
      walletTrade:false,poolPdaVerified:true,reason:'Signed user sells another mint; MBC moves directly from its upstream pool into the next Pump pool'});
  }
  return matches.length===1?matches[0]:null;
}

// Native SELL proceeds can be smaller than tips/network fees. Prove the route
// receipt instead of treating the wallet's final SOL sign as trade direction.
function negativeNativeSellSettlement(tx,mint,trader,pool,event,groups) {
  if(event.buy||event.solRaw<=0n||groups.length!==1)return null;
  const raw=tx.raw,keys=tx.accountKeys;
  const rawKeys=raw.transaction.message.accountKeys.map(k=>typeof k==='string'?k:k.pubkey);
  if(keys.length!==new Set(keys).size||keys.length!==rawKeys.length||keys.some((k,i)=>k!==rawKeys[i]))return null;
  const pre=raw.meta.preBalances,post=raw.meta.postBalances,fee=raw.meta.fee;
  if(pre.length!==keys.length||post.length!==keys.length||!Number.isSafeInteger(fee)||fee<0
    ||[...pre,...post].some(n=>!Number.isSafeInteger(n)||n<0)
    ||pre.some((n,i)=>n!==tx.preBalances[i])||post.some((n,i)=>n!==tx.postBalances[i]))return null;
  try {
    const {PublicKey}=require('@solana/web3.js');
    const curve=PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'),new PublicKey(mint).toBuffer()],new PublicKey(PUMP))[0].toBase58();
    if(curve!==pool.owner)return null;
  }catch{return null;}
  const poolIndex=keys.indexOf(pool.owner),userIndex=keys.indexOf(trader.owner);
  if(poolIndex<0||userIndex<0||poolIndex===userIndex)return null;
  const adjusted=pre.map((n,i)=>BigInt(post[i])-BigInt(n));adjusted[0]+=BigInt(fee);
  let outsideWalletFlow=0n;
  const routeIndex=groups[0].index;
  for(const group of raw.meta.innerInstructions||[])if(group.index!==routeIndex&&group.instructions.length)return null;
  for(const [index,ix]of raw.transaction.message.instructions.entries()) {
    if(index===routeIndex)continue;
    if(ix.programId==='ComputeBudget111111111111111111111111111111')continue;
    const info=ix.parsed?.info;
    if(ix.programId!=='11111111111111111111111111111111'||ix.parsed?.type!=='transfer'
      ||!Number.isSafeInteger(info?.lamports)||info.lamports<0)return null;
    const source=keys.indexOf(info.source),destination=keys.indexOf(info.destination);
    if(source<0||destination<0)return null;
    const n=BigInt(info.lamports);adjusted[source]+=n;adjusted[destination]-=n;
    if(source===userIndex)outsideWalletFlow-=n;
    if(destination===userIndex)outsideWalletFlow+=n;
  }
  const received=adjusted[userIndex];
  // Once explicit outside transfers and the network fee are removed, the
  // canonical pool must be the only funding source. Other debits could hide
  // account rent refunds, competing swaps or an unrelated native withdrawal.
  if(adjusted[poolIndex]!==-event.solRaw||received<=0n||received>event.solRaw
    ||adjusted.some((n,i)=>i!==poolIndex&&n<0n)||adjusted.reduce((a,b)=>a+b,0n)!==0n)return null;
  return {receivedRaw:String(received),grossPoolDebitRaw:String(event.solRaw),
    routeDeductionsRaw:String(event.solRaw-received),outsideWalletFlowRaw:String(outsideWalletFlow),
    walletDeltaRaw:String(BigInt(post[userIndex])-BigInt(pre[userIndex])),networkFeeRaw:String(fee),
    pool:pool.owner,routeInstructionGroup:routeIndex,feePayer:keys[0]};
}

function decodePumpSwap(tx, mint) {
  if (tx?.transactionError !== null || tx.raw?.meta?.err !== null || !Number.isSafeInteger(tx.slot)) return null;
  const raw = tx.raw;
  if (raw.transaction?.signatures?.[0] !== tx.signature) return null;
  const events = pumpEvents(raw).filter(e => e.mint === mint);
  // One canonical token_trades row cannot safely represent multiple swap legs.
  if (events.length !== 1) return null;
  const event = events[0];
  if (event.solRaw < 0n || event.tokenRaw <= 0n || event.solRaw > BigInt(Number.MAX_SAFE_INTEGER)
      || event.tokenRaw > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const keys = raw.transaction.message.accountKeys;
  const signers = new Set(keys.filter(k => k?.signer === true).map(k => k.pubkey));
  let deltas = (tx.tokenBalanceDeltas || []).filter(d => d.mint === mint && d.deltaRaw !== "0");
  let poolMintedRaw = null;
  // A launch can mint the initial supply into the pool and BUY in one tx.
  // Subtract only an explicit mint into a newly created, non-signing pool
  // account whose remaining balance exactly equals mint minus this trade.
  if(event.buy) {
    const instructions=[...raw.transaction.message.instructions,...(raw.meta.innerInstructions||[]).flatMap(g=>g.instructions)];
    const mints=instructions.filter(ix=>TOKEN_PROGRAMS.has(ix.programId)&&ix.parsed?.type==='mintTo'&&ix.parsed.info.mint===mint);
    if(mints.length===1 && /^\d+$/.test(mints[0].parsed.info.amount||'')) {
      const info=mints[0].parsed.info, minted=BigInt(info.amount);
      const poolDelta=deltas.find(d=>!signers.has(d.owner)&&d.tokenAccount===info.account&&BigInt(d.deltaRaw)===minted-event.tokenRaw);
      const existed=(tx.preTokenBalances||[]).some(b=>b.mint===mint&&tx.accountKeys[b.accountIndex]===info.account);
      if(poolDelta && !existed && (tx.postTokenBalances||[]).filter(b=>b.mint===mint&&b.owner===poolDelta.owner).length===1) {
        poolMintedRaw=String(minted);
        deltas=deltas.map(d=>d===poolDelta?{...d,deltaRaw:String(-event.tokenRaw)}:d);
      }
    }
  }
  if (deltas.some(d => !d.owner || !/^-?\d+$/.test(d.deltaRaw))) return null;
  const signedAmount = event.buy ? event.tokenRaw : -event.tokenRaw;
  const split = splitBuy(tx, mint, event, deltas, signers) || forwardedBuy(tx,mint,event,deltas,signers);
  const candidates = deltas.filter(d => signers.has(d.owner) && BigInt(d.deltaRaw) === signedAmount);
  if (!split && (deltas.length !== 2 || candidates.length !== 1)) return decodeLimitOrderSell(tx,mint,event,deltas,signers);
  const trader = split ? split.trader : candidates[0];
  const pools = deltas.filter(d => d.owner !== trader.owner && BigInt(d.deltaRaw) === -signedAmount);
  if (pools.length !== 1 || !Number.isInteger(trader.decimals) || trader.decimals < 0 || trader.decimals > 18) return null;
  const pool = pools[0], owners = tokenAccounts(tx, mint);
  const userAccounts = new Set([...owners].filter(([, owner]) => owner === trader.owner).map(([a]) => a));
  const poolAccounts = new Set([...owners].filter(([, owner]) => owner === pool.owner).map(([a]) => a));
  const provenGroups = split ? [split.group] : [];
  for (const group of raw.meta.innerInstructions || []) {
    const outer = raw.transaction.message.instructions[group.index];
    if (outer?.programId !== PUMP && !group.instructions.some(ix => ix.programId === PUMP)) continue;
    const transfers = group.instructions.filter(ix => TOKEN_PROGRAMS.has(ix.programId)
      && ix.parsed?.type === "transferChecked" && ix.parsed.info.mint === mint
      && ix.parsed.info.tokenAmount?.amount === String(event.tokenRaw)).map(ix => ix.parsed.info);
    if (hasPath(transfers, event.buy ? poolAccounts : userAccounts, event.buy ? userAccounts : poolAccounts,
      owners, event.protocolUser) && !provenGroups.includes(group)) provenGroups.push(group);
  }
  if (!provenGroups.length) return null;
  // A routed sell may settle in USDC rather than SOL. Do not pretend the
  // protocol's intermediate SOL leg is the seller's received quote.
  const quoteOwner = split ? split.quoteOwner : trader.owner;
  const route=event.solRaw===0n?wxmrRoute(tx,mint,quoteOwner,event.buy,provenGroups,pool.owner):{groups:provenGroups};
  if(!route)return null;
  const settlementGroups=route.groups;
  const quoteDeltas = route.currency && (route.currency!==SOL || (tx.tokenBalanceDeltas||[]).some(d=>d.owner===quoteOwner&&d.mint===SOL&&d.deltaRaw!=="0")) ? [{
    owner:quoteOwner,mint:route.currency,
    decimals: route.currency===SOL?9:(tx.tokenBalanceDeltas||[]).find(d=>d.mint===route.currency)?.decimals,
    deltaRaw:(tx.tokenBalanceDeltas||[]).find(d=>d.owner===quoteOwner&&d.mint===route.currency)?.deltaRaw||'0',
  }] : (tx.tokenBalanceDeltas || []).filter(d => (!route.currency||d.mint===route.currency)&&d.owner === quoteOwner
    && d.mint !== mint && /^-?\d+$/.test(d.deltaRaw) && BigInt(d.deltaRaw) !== 0n);
  let routeQuoteDelta = null, nativeSettlement = null;
  let quoteMint = SOL, quoteAmount = Number(event.solRaw) / 1e9, quoteDecimals = 9;
  // The legacy SOL field is not a token quote or a conversion rate.
  if (event.solRaw === 0n) {
    if ([...tx.preTokenBalances, ...tx.postTokenBalances].some(b => b.mint === WXMR && b.uiTokenAmount?.decimals !== 12)) return null;
    const poolFlows = provenGroups.map(g => cashFlow(tx,g.instructions,WXMR,pool.owner));
    if (poolFlows.some(n => n === null)) return null;
    const poolFlow = poolFlows.reduce((a,b) => a+b,0n);
    if (event.buy ? poolFlow <= 0n : poolFlow >= 0n) return null;
  }
  if (quoteDeltas.length) {
    if (quoteDeltas.length !== 1) return null;
    const quote = quoteDeltas[0], amount = BigInt(quote.deltaRaw);
    if ((!route.currency && (event.buy ? amount >= 0n : amount <= 0n)) || !Number.isInteger(quote.decimals)
        || quote.decimals < 0 || quote.decimals > 18 || (amount < 0n ? -amount : amount) > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    if (split?.quoteMint && quote.mint !== split.quoteMint) return null;
    const all = [...raw.transaction.message.instructions, ...(raw.meta.innerInstructions || []).flatMap(g=>g.instructions)];
    let observedFlow=cashFlow(tx, all, quote.mint, quoteOwner);
    if(observedFlow!==amount && quote.mint===SOL && route.currency===SOL) {
      // syncNative converts explicit native deposits into wrapped-token balance.
      const owners=tokenAccounts(tx,SOL);
      const synced=new Set(all.filter(ix=>TOKEN_PROGRAMS.has(ix.programId)&&ix.parsed?.type==='syncNative').map(ix=>ix.parsed.info.account));
      const deposits=all.filter(ix=>ix.programId==='11111111111111111111111111111111'&&ix.parsed?.type==='transfer'
        &&ix.parsed.info.source===quoteOwner&&owners.get(ix.parsed.info.destination)===quoteOwner&&synced.has(ix.parsed.info.destination));
      if(observedFlow!==null)for(const ix of deposits){if(!Number.isSafeInteger(ix.parsed.info.lamports)||ix.parsed.info.lamports<0)return null;observedFlow+=BigInt(ix.parsed.info.lamports)}
    }
    if (observedFlow !== amount) return null;
    const routeFlows = settlementGroups.map(g => cashFlow(tx,g.instructions,quote.mint,quoteOwner));
    if (routeFlows.some(n => n === null)) return null;
    const routeAmount = route.protocolWxmrFlow ?? routeFlows.reduce((a,b) => a+b,0n);
    if (event.buy ? routeAmount >= 0n : routeAmount <= 0n) return null;
    const absolute = routeAmount < 0n ? -routeAmount : routeAmount;
    if (absolute > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    routeQuoteDelta = routeAmount;
    quoteMint = quote.mint; quoteDecimals = quote.decimals;
    quoteAmount = Math.abs(Number(routeQuoteDelta)) / 10 ** quoteDecimals;
  } else {
    if (event.solRaw === 0n) {
      if(route.currency && route.currency!==SOL)return null;
      const flows = settlementGroups.map(g => cashFlow(tx,g.instructions,SOL,quoteOwner));
      if (flows.some(n => n === null)) return null;
      const flow = flows.reduce((a,b) => a+b,0n);
      if ((event.buy ? flow >= 0n : flow <= 0n) || (flow < 0n ? -flow : flow) > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      routeQuoteDelta = flow;
      quoteAmount = Math.abs(Number(flow)) / 1e9;
    }
    const index = tx.accountKeys.indexOf(quoteOwner);
    const delta = tx.postBalances[index] - tx.preBalances[index];
    if (!Number.isFinite(delta)) return null;
    if(event.buy ? delta>=0 : delta<=0) {
      nativeSettlement=negativeNativeSellSettlement(tx,mint,trader,pool,event,provenGroups);
      if(!nativeSettlement)return null;
      routeQuoteDelta=BigInt(nativeSettlement.receivedRaw);
      quoteAmount=Number(routeQuoteDelta)/1e9;
    }
  }
  const amountTokens = Math.abs(Number(trader.deltaRaw)) / 10 ** trader.decimals;
  const amountSol = quoteMint === SOL ? quoteAmount : 0;
  return { signature: tx.signature, timestamp: tx.timestamp, slot: tx.slot, trader: trader.owner,
    type: event.buy ? "buy" : "sell", amountTokens, amountSol, priceSol: amountSol / amountTokens,
    quoteMint, quoteAmount, quoteDecimals,
    quoteAmountRaw: String(routeQuoteDelta === null ? event.solRaw : routeQuoteDelta < 0n ? -routeQuoteDelta : routeQuoteDelta), fee: Number(raw.meta.fee || 0) / 1e9,
    feeLamports: Number(raw.meta.fee || 0), source: "alchemy", decoderCoverage: "swap_only",
    attribution: "pump_event_and_checked_transfer_path", protocolTrader: event.protocolUser,
    ...(event.solRaw > 0n ? { protocolAmountSol: Number(event.solRaw) / 1e9 } : { settlementEvidence: "wxmr_pool_and_wallet_transfer_ledger" }),
    ...(nativeSettlement ? {settlementEvidence:'native_pool_debit_and_balanced_route_ledger',nativeSettlement} : {}),
    ...(quoteDeltas.length ? { quoteWalletDeltaRaw: quoteDeltas[0].deltaRaw,
      quoteRouteDeltaRaw: String(routeQuoteDelta),
      quoteExternalDeltaRaw: String(BigInt(quoteDeltas[0].deltaRaw) - routeQuoteDelta) } : {}),
    ...(route.currency ? { intermediateQuoteMint: WXMR, intermediateQuoteDeltaRaw: route.intermediateDeltaRaw, settlementGroupIndices: settlementGroups.map(g=>g.index) } : {}),
    ...(route.protocolWxmrFlow !== undefined ? { settlementBasis: "protocol_quote_before_forwarding" } : {}),
    ...(poolMintedRaw ? { poolMintedRaw } : {}),
    ...(split ? { fundedBy: split.quoteOwner, grossTokenAmountRaw: split.grossTokenAmountRaw,
      tokenDeductions: split.tokenDeductions, attribution: split.forwarded ? "signed_funder_and_exact_forwarded_recipient" : "router_swap_tob_recipient_and_split_transfer_ledger" } : {}) };
}
module.exports = { decodePumpSwap, pumpEvents, classifyIntermediatePumpSell };
