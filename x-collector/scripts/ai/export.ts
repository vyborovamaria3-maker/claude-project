import { once } from 'node:events';
import { parseArgv } from '../../lib/trade/cli';
// Load dotenv-dependent modules only after suppressing its stdout banner: stdout is JSONL.
process.env.DOTENV_CONFIG_QUIET='true';
async function main(){
 const {exportInputs}=await import('../../lib/ai/data');
 const {closePool}=await import('../../lib/trade/pg');
 try{
  const args=parseArgv(process.argv.slice(2));
  for await(const row of exportInputs({from:String(args.flags.from??''),to:String(args.flags.to??''),asOf:String(args.flags['as-of']??''),batch:args.flags.batch===undefined?undefined:Number(args.flags.batch)})){
   if(!process.stdout.write(JSON.stringify(row)+'\n'))await once(process.stdout,'drain');
  }
 }finally{await closePool();}
}
main().catch(()=>{console.error('AI export failed: check date arguments, database and migration 018');process.exitCode=1;});
