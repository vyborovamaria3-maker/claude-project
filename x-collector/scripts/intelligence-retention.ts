import 'dotenv/config';
import {tx,closePool} from '../lib/trade/pg';
import {applyIntelligenceRetention} from '../lib/intelligence/retention';

function arg(name:string):string|undefined{
 const index=process.argv.indexOf('--'+name);
 return index>=0?process.argv[index+1]:undefined;
}

async function main(){
 const report=await tx((c)=>applyIntelligenceRetention(c,{
  snapshotDays:arg('snapshot-days')===undefined?undefined:Number(arg('snapshot-days')),
  batchSize:arg('batch-size')===undefined?undefined:Number(arg('batch-size')),
  dryRun:process.argv.includes('--dry-run'),
 }));
 console.log(JSON.stringify(report,null,2));
}
main().catch(e=>{
 console.error(e instanceof Error?e.message:String(e));
 process.exitCode=1;
}).finally(closePool);
