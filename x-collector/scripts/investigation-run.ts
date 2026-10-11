import 'dotenv/config';
import {tx,closePool} from '../lib/trade/pg';
import {
 getInvestigation,runInvestigation,listInvestigations,InvestigationError,
 type InvestigationPriority,type InvestigationStatus,
} from '../lib/intelligence/investigation-runner';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function arg(name:string):string|undefined{
 const index=process.argv.indexOf('--'+name);
 return index>=0?process.argv[index+1]:undefined;
}
function has(name:string):boolean{return process.argv.includes('--'+name);}
function numberArg(name:string,fallback:number):number{
 const raw=arg(name);
 return raw===undefined?fallback:Number(raw);
}

async function main(){
 await tx(async c=>{
  if(has('list')){
   const rows=await listInvestigations(c,{
    status:arg('status')as InvestigationStatus|undefined,
    limit:Math.min(200,Math.max(1,numberArg('limit',50))),
    offset:Math.max(0,numberArg('offset',0)),
   });
   console.log(JSON.stringify({investigations:rows.length,rows},null,2));
   return;
  }
  const id=arg('id');
  if(id){
   if(!UUID.test(id))throw new InvestigationError('Некорректный --id');
   const bundle=await getInvestigation(c,id);
   console.log(JSON.stringify(bundle,null,2));
   return;
  }
  const entity=arg('entity');
  if(!entity||!UUID.test(entity))throw new InvestigationError('Укажите --entity <uuid>, --id <uuid> или --list');
  const report=await runInvestigation(c,entity,{
   title:arg('title'),
   hypothesis:arg('hypothesis'),
   priority:arg('priority')as InvestigationPriority|undefined,
   createdBy:arg('created-by'),
   maxEvidence:arg('max-evidence')===undefined?undefined:Math.max(0,numberArg('max-evidence',5)),
  });
  console.log(JSON.stringify({
   investigation:report.investigation,
   steps:report.steps.length,
   observations:report.observations,
   evidence_events:report.evidenceEvents.length,
  },null,2));
 });
}
main().catch(e=>{console.error(e instanceof Error?e.message:String(e));process.exitCode=1;}).finally(closePool);
