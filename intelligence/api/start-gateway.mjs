#!/usr/bin/env node
import pg from "pg";
import {createPotapoffGateway} from "./gateway.mjs";
async function main(){
  if(process.env.POTAPOFF_GATEWAY_ENABLED!=="true")
    throw new Error("gateway_opt_in_required");
  const apiToken=process.env.INTELLIGENCE_API_TOKEN;
  const raw=JSON.parse(process.env.POTAPOFF_GATEWAY_CLIENTS_JSON??"[]");
  if(!Array.isArray(raw)||!raw.length)throw new Error("gateway_clients_required");
  const clients=raw.map(item=>({
    id:item.id,role:item.role,token:process.env[item.tokenEnv]??"",
  }));
  const dbUrl=process.env.INTELLIGENCE_GATEWAY_AUDIT_DATABASE_URL;
  if(!dbUrl)throw new Error("gateway_audit_database_required");
  const port=Number(process.env.POTAPOFF_GATEWAY_PORT??3183);
  if(!Number.isSafeInteger(port)||port<1||port>65535)throw new Error("invalid_gateway_port");
  const audit=new pg.Pool({connectionString:dbUrl,max:2,connectionTimeoutMillis:3000,
    query_timeout:4000,statement_timeout:3500});
  let server;
  try{
    await audit.query("SELECT 1 FROM gateway_auth_log LIMIT 1");
    server=createPotapoffGateway({clients,internalApiToken:apiToken,auditDb:audit,
      internalApiPort:Number(process.env.INTELLIGENCE_API_PORT??3182)});
    await new Promise((resolve,reject)=>{
      server.once("error",reject);
      server.listen(port,"127.0.0.1",()=>{server.off("error",reject);resolve()});
    });
    const shutdown=()=>server.close(()=>{void audit.end()});
    process.once("SIGINT",shutdown);process.once("SIGTERM",shutdown);
    process.stdout.write("Potapoff gateway bound to loopback\n");
  }catch(error){if(server)server.close();await audit.end();throw error}
}
main().catch(()=>{
  process.stderr.write("gateway_configuration_or_audit_unavailable\n");
  process.exitCode=1;
});
