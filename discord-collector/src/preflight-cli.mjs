import {pathToFileURL} from "node:url";
import {resolve} from "node:path";
import {readAuthorizationFile} from "./authorization-file.mjs";
import {validateAuthorization} from "./events.mjs";
import {runDiscordPermissionPreflight} from "./permission-preflight.mjs";

export async function runPermissionPreflightCli({
  env=process.env,
  fetchImpl=globalThis.fetch,
  write=output=>console.log(output),
  now=new Date(),
}={}){
  const authorizationPath=env.DISCORD_AUTHORIZATION_PATH;
  const token=env.DISCORD_BOT_TOKEN;
  if(typeof authorizationPath!=="string"||!authorizationPath.trim())
    throw new Error("DISCORD_AUTHORIZATION_PATH is required");
  if(typeof token!=="string"||!token.trim())
    throw new Error("DISCORD_BOT_TOKEN is required");
  if(env===process.env)delete process.env.DISCORD_BOT_TOKEN;

  const document=await readAuthorizationFile(authorizationPath);
  const authorization=validateAuthorization(document,{now});
  if(authorization.size===0)
    throw new Error("No active authorized channels are available for permission preflight");

  const maxChannels=Number(env.DISCORD_PERMISSION_PREFLIGHT_MAX_CHANNELS||1_000);
  if(!Number.isInteger(maxChannels)||maxChannels<1||maxChannels>10_000)
    throw new RangeError("DISCORD_PERMISSION_PREFLIGHT_MAX_CHANNELS must be in 1..10000");

  const report=await runDiscordPermissionPreflight({
    authorization,token,fetchImpl,maxChannels,now,
  });
  const messageContentIntentAttested=env.DISCORD_MESSAGE_CONTENT_INTENT_CONFIRMED==="true";
  const preflightGateEnabled=env.DISCORD_PERMISSION_PREFLIGHT_ENABLED==="true";
  const result={
    ...report,
    messageContentIntent:{
      operatorAttested:messageContentIntentAttested,
      independentlyVerified:false,
    },
    preflightGateEnabled,
    preflightReady:report.ok&&messageContentIntentAttested&&preflightGateEnabled,
  };
  write(JSON.stringify(result,null,2));
  return {exitCode:result.preflightReady?0:1,result};
}

const invokedPath=process.argv[1]?pathToFileURL(resolve(process.argv[1])).href:null;
if(invokedPath===import.meta.url){
  try{
    const result=await runPermissionPreflightCli();
    process.exitCode=result.exitCode;
  }catch{
    console.error("Discord permission preflight CLI failed","preflight_cli_failed");
    process.exitCode=1;
  }
}
