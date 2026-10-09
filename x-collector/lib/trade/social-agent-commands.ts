import type { PoolClient } from "pg";
import { log } from "./logger";
import { tx } from "./pg";
import { executeAgentCycle } from "./social-agent-cycle";
import { executeDiscoveryCycle } from "./social-discovery";
import { previewProvider } from "./social-agent";
export async function executeAgentCommand(client: Pick<PoolClient,"query">) {
    await client.query("SELECT id FROM social_agent_settings WHERE id=1 FOR UPDATE");
    const rows=await client.query<{id:string;kind:string}>("SELECT id,kind FROM social_agent_commands WHERE status='pending' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED");
    const command=rows.rows[0];if(!command)return null;
    await client.query("SAVEPOINT agent_command");
    try {
      const result=command.kind==="discover"?{queued:await executeDiscoveryCycle(client,Date.now())}:await executeAgentCycle(client,previewProvider,Date.now());
      await client.query("UPDATE social_agent_commands SET status='done',result=$1::jsonb,completed_at=$2 WHERE id=$3",[JSON.stringify(result),Date.now(),command.id]);
      return {id:command.id,status:"done"};
    } catch (error) {
      log.error("social agent command failed", {id:command.id,errorType:error instanceof Error?error.name:"unknown"});
      await client.query("ROLLBACK TO SAVEPOINT agent_command");
      await client.query("UPDATE social_agent_commands SET status='failed',error=$1,completed_at=$2 WHERE id=$3",["Цикл не выполнен. Подробности в журнале планировщика.",Date.now(),command.id]);
      return {id:command.id,status:"failed"};
    }
}
export function processAgentCommand() { return tx(client=>executeAgentCommand(client)); }
