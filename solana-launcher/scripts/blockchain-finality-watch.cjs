#!/usr/bin/env node
"use strict";
// Operator-invoked persistent watcher. Each tick audits existing RAW only.
// An external signed, challenge-bound finalized receipt service is required
// before any true "finalized" or "stable" status can be asserted.
const {runPaths}=require("./blockchain-finality-watch-state.cjs");
function parse(argv){
  const a={db:null,state:null,limit:25,signature:null,kind:null,address:null,
    watch:false,intervalSeconds:300};
  for(let i=0;i<argv.length;i++){
    if(["--db","--state","--limit","--signature","--kind","--address","--interval-seconds"].includes(argv[i])&&argv[i+1]){
      const k=argv[i].slice(2);
      if(k==="interval-seconds")a.intervalSeconds=Number(argv[++i]);
      else a[k]=argv[++i];
    }else if(argv[i]==="--watch")a.watch=true;
    else throw Error("Usage: --db existing.db --state separate.db [--limit 25] [--signature SIG | --kind wallet --address WALLET] [--watch --interval-seconds 300]");
  }
  if(!a.db||!a.state)throw Error("Explicit --db and --state required");
  a.limit=Number(a.limit);
  if(!Number.isInteger(a.limit)||a.limit<1||a.limit>100)throw Error("limit must be 1..100");
  if(!Number.isInteger(a.intervalSeconds)||a.intervalSeconds<60||a.intervalSeconds>3600)
    throw Error("interval-seconds must be between 60 and 3600");
  return a;
}
function once(args){return runPaths(args);}
async function run(argv=process.argv.slice(2)){
  const a=parse(argv);
  if(!a.watch){console.log(JSON.stringify(once(a),null,2));return;}
  let stopping=false;
  const stop=()=>{stopping=true;};
  process.once("SIGINT",stop);
  process.once("SIGTERM",stop);
  while(!stopping){
    console.log(JSON.stringify({at:new Date().toISOString(),...once(a)}));
    if(stopping)break;
    // No concurrent ticks: next begins only after the previous finishes.
    await new Promise(resolve=>{
      const cleanup=()=>{process.removeListener("SIGINT",done);process.removeListener("SIGTERM",done);};
      function done(){clearTimeout(timeout);cleanup();resolve();}
      const timeout=setTimeout(done,a.intervalSeconds*1000);
      process.once("SIGINT",done);
      process.once("SIGTERM",done);
    });
  }
}
if(require.main===module)run().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={parse,once,run};
