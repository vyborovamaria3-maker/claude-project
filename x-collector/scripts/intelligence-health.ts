import 'dotenv/config';
import {tx,closePool} from '../lib/trade/pg';
import {checkIntelligenceHealth} from '../lib/intelligence/intelligence-health';

async function main(){
 const health=await tx((c)=>checkIntelligenceHealth(c));
 console.log(JSON.stringify(health,null,2));
 if(health.status!=="healthy")process.exitCode=1;
}
main().catch(e=>{console.error(e instanceof Error?e.message:String(e));process.exitCode=1;}).finally(closePool);
