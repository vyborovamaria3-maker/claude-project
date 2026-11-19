import {pathToFileURL} from "node:url";
import {resolve} from "node:path";
import pg from "pg";
import {installSchema,eraseAuthorMessages} from "./storage.mjs";

export function parseEraseUserArgs(args){
  let authorId=null,confirm=false;
  for(let i=0;i<args.length;i++){
    const arg=args[i];
    if(arg==="--author-id"){
      if(authorId!==null||!args[i+1])throw new Error("Exactly one --author-id is required");
      authorId=args[++i];
    }else if(arg==="--confirm")confirm=true;
    else if(arg==="--help")return {help:true};
    else throw new Error("Unknown erase-user argument");
  }
  if(!authorId||!confirm)throw new Error("--author-id and explicit --confirm are required");
  if(!/^[1-9][0-9]{14,21}$/.test(authorId)||BigInt(authorId)>18446744073709551615n)
    throw new Error("Invalid Discord author Snowflake");
  return {authorId,confirm};
}

export async function runEraseUserCli({
  env=process.env,args=process.argv.slice(2),write=value=>console.log(value),
}={}){
  const parsed=parseEraseUserArgs(args);
  if(parsed.help){
    write("Usage: npm run erase-user -- --author-id <discord-snowflake> --confirm");
    return {exitCode:0};
  }
  const connectionString=env.DISCORD_SOURCE_DATABASE_URL;
  if(typeof connectionString!=="string"||!connectionString.trim())
    throw new Error("DISCORD_SOURCE_DATABASE_URL is required");
  const pool=new pg.Pool({connectionString,max:2,connectionTimeoutMillis:10_000,
    keepAlive:true,application_name:"potapoff-discord-erasure"});
  try{
    await installSchema(pool);
    const result=await eraseAuthorMessages(pool,parsed.authorId);
    // Never print the requested author ID or any message-level identifier.
    write(JSON.stringify({status:"completed",...result}));
    return {exitCode:0,result};
  }finally{await pool.end()}
}

const invokedPath=process.argv[1]?pathToFileURL(resolve(process.argv[1])).href:null;
if(invokedPath===import.meta.url){
  try{
    const result=await runEraseUserCli();
    process.exitCode=result.exitCode;
  }catch{
    console.error("Discord user erasure failed","user_erasure_failed");
    process.exitCode=1;
  }
}
