#!/usr/bin/env node
import "dotenv/config";
import {addresses} from "../lib/archive/model";
import {q,tx,closePool,AmbiguousCommitError} from "../lib/trade/pg";
import {verifySolanaMintViaAlchemy} from "../src/collector/persistence/solana-mint-proof";
import {
  emitXVerifiedTokenLinkOutbox,xVerifiedTokenLinksEnabled,
} from "../src/collector/persistence/verified-token-links";

export function parseMintVerificationArgs(args:string[]){
  const opts={limit:20,maxRpc:20,cursor:"0",execute:false,help:false};
  for(let i=0;i<args.length;i++){
    const [flag,inline]=args[i]!.includes("=")
      ?[args[i]!.slice(0,args[i]!.indexOf("=")),args[i]!.slice(args[i]!.indexOf("=")+1)]
      :[args[i]!,undefined];
    if(flag==="--help")opts.help=true;
    else if(flag==="--execute")opts.execute=true;
    else if(["--limit","--max-rpc","--cursor"].includes(flag)){
      const raw=inline??args[++i];
      if(!raw)throw new TypeError("invalid verification option");
      if(flag==="--cursor"){
        if(!/^(?:0|[1-9][0-9]{0,24})$/.test(raw))throw new TypeError("invalid cursor");
        opts.cursor=raw;
      }else{
        const num=Number(raw);
        if(!Number.isSafeInteger(num)||num<1||num>50)throw new RangeError("verification budgets must be 1..50");
        if(flag==="--limit")opts.limit=num;else opts.maxRpc=num;
      }
    }else throw new TypeError("unknown verification option");
  }
  return opts;
}

type Tweet={tweet_id:string;author_id:string|null;text:string|null;posted_at:string|number|null};
export async function verifyXTokenLinksOnce(options:ReturnType<typeof parseMintVerificationArgs>,
  deps?:{
    read?:(cursor:string,limit:number)=>Promise<Tweet[]>;
    verify?:(mint:string)=>Promise<Awaited<ReturnType<typeof verifySolanaMintViaAlchemy>>>;
    emit?:(tweet:Tweet,mint:string,proof:NonNullable<Awaited<ReturnType<typeof verifySolanaMintViaAlchemy>>>)=>Promise<boolean>;
  },
){
  if(options.execute&&(
    !xVerifiedTokenLinksEnabled() ||
    process.env.X_INTELLIGENCE_MINT_VERIFY_ENABLED!=="true"
  ))throw new Error("x_mint_verification_explicit_opt_in_required");
  const rpcUrl=process.env.ALCHEMY_SOLANA_RPC_URL?.trim();
  if(options.execute&&(!rpcUrl || !/^https:\/\//.test(rpcUrl))){
    throw new Error("alchemy_rpc_configuration_required");
  }
  const read=deps?.read??(async(cursor,limit)=>q<Tweet>(
    "SELECT tweet_id,author_id,text,posted_at FROM twitter_tweets "+
    "WHERE tweet_id>$1 ORDER BY tweet_id ASC LIMIT $2",[cursor,limit],
  ));
  const verify=deps?.verify??(mint=>verifySolanaMintViaAlchemy(rpcUrl!,mint));
  const emit=deps?.emit??(async(tweet,mint,proof)=>tx(async client=>{
    // The owner of the native transaction re-reads under a row lock after
    // the RPC call. Changed/deleted/not-yet-stable source evidence fails closed.
    const result=await client.query<Tweet>(
      "SELECT tweet_id,author_id,text,posted_at FROM twitter_tweets "+
      "WHERE tweet_id=$1 FOR UPDATE",[tweet.tweet_id],
    );
    const current=result.rows[0];
    if(!current||current.text!==tweet.text||
       !current.author_id||current.author_id!==tweet.author_id||
       String(current.posted_at??"")!==String(tweet.posted_at??"")){
      return false;
    }
    return emitXVerifiedTokenLinkOutbox(client,{
      tweetId:current.tweet_id,authorId:current.author_id,
      text:current.text??"",mint,observedAt:new Date(),
      postedAt:current.posted_at===null?null:new Date(Number(current.posted_at)),
      mintVerification:proof,
    });
  }));
  const rows=await read(options.cursor,options.limit);
  if(rows.length>options.limit)throw new Error("source returned too many tweets");
  let candidates=0,requests=0,verified=0,rejected=0,deferred=0,emitted=0,skipped=0;
  const cache=new Map<string,Awaited<ReturnType<typeof verifySolanaMintViaAlchemy>>>();
  let nextCursor=options.cursor;
  let budgetHit=false;
  let haltedReason:"rpc_deferred"|"source_write_failed"|"source_commit_uncertain"|null=null;
  rowLoop:for(const tweet of rows){
    const matches=addresses(tweet.text??"").slice(0,3);
    const validId=/^[1-9][0-9]{0,24}$/;
    if(!validId.test(tweet.tweet_id)||!tweet.author_id||!validId.test(tweet.author_id)){
      skipped++;nextCursor=tweet.tweet_id;continue;
    }
    if(!options.execute){
      candidates+=matches.length;nextCursor=tweet.tweet_id;continue;
    }
    if(matches.some(m=>!cache.has(m)) && requests+matches.filter(m=>!cache.has(m)).length>options.maxRpc){
      budgetHit=true;break; // resume at LAST COMPLETED tweet, not partial row
    }
    for(const mint of matches){
      candidates++;
      if(!cache.has(mint)){
        requests++;
        try{cache.set(mint,await verify(mint))}
        catch{deferred++;haltedReason="rpc_deferred";break rowLoop;} // retry this tweet on next run
      }
      const proof=cache.get(mint);
      if(!proof){rejected++;continue;}
      verified++;
      try{if(await emit(tweet,mint,proof))emitted++;else skipped++;}
      catch(error){
        deferred++;
        haltedReason=error instanceof AmbiguousCommitError
          ?"source_commit_uncertain":"source_write_failed";
        break rowLoop; // preserve cursor; resolve uncertain COMMIT before another run
      }
    }
    nextCursor=tweet.tweet_id;
  }
  return {mode:options.execute?"execute":"dry_run",scanned:rows.length,
    candidates,requests,verified,rejected,deferred,emitted,skipped,
    nextCursor,budgetHit,haltedReason};
}
async function main(){
  const args=parseMintVerificationArgs(process.argv.slice(2));
  if(args.help){
    console.log("Offline candidate scan (default): node --import tsx scripts/verify-x-token-links.ts --limit=20 --cursor=0");
    console.log("Explicit RPC/write: X_INTELLIGENCE_OUTBOX_ENABLED=true X_INTELLIGENCE_TOKEN_LINKS_ENABLED=true X_INTELLIGENCE_MINT_VERIFY_ENABLED=true");
    console.log(" node --import tsx scripts/verify-x-token-links.ts --execute --limit=20 --max-rpc=20 --cursor=0");
    return;
  }
  try{console.log(JSON.stringify(await verifyXTokenLinksOnce(args)));}
  finally{await closePool();}
}
if(require.main===module){
  main().catch(()=>{
    console.error("X mint verifier failed: configuration_or_source_error");
    process.exitCode=1;
  });
}
