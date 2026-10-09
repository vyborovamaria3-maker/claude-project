import { runAgentCycle } from "../lib/trade/social-agent-cycle";
import { q, closePool } from "../lib/trade/pg";
import { runDiscoveryCycle } from "../lib/trade/social-discovery";
async function main() {
  const command=process.argv[2]??"status";
  if(command==="start"||command==="stop") {
    await q("UPDATE social_agent_settings SET stopped=$1,updated_at=$2 WHERE id=1",[command==="stop",Date.now()]);
    console.log(command==="stop"?"Agent stopped":"Preview agent started; no actions are sent to X");
  } else if(command==="run") console.log(JSON.stringify(await runAgentCycle(),null,2));
  else if(command==="discover") console.log(JSON.stringify({queued:await runDiscoveryCycle()}));
  else if(command==="status") console.log(JSON.stringify(await q("SELECT * FROM social_agent_settings"),null,2));
  else throw new Error("Usage: npm run agent -- start|stop|run|discover|status");
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>closePool());
