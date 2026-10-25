#!/usr/bin/env node
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {validateApiToken} from "../api/server.mjs";
import {validateModelConfig} from "./provider.mjs";
import {createAiGateway} from "./server.mjs";

const integerPort=value=>{
  if(typeof value!=="string"||!/^[1-9][0-9]*$/.test(value)||
     Number(value)>65535)throw new TypeError("invalid_ai_gateway_port");
  return Number(value);
};
export function gatewayConfiguration(env=process.env){
  if(env.AI_GATEWAY_ENABLED!=="true")throw new Error("ai_gateway_explicit_opt_in_required");
  if(env.AI_GATEWAY_EGRESS_ENABLED!=="true")
    throw new Error("ai_gateway_external_provider_egress_opt_in_required");
  if(env.INTELLIGENCE_AI_API_ENABLED!=="true")
    throw new Error("intelligence_ai_read_model_opt_in_required");
  const clientToken=validateApiToken(env.AI_GATEWAY_CLIENT_TOKEN);
  const intelligenceToken=validateApiToken(env.INTELLIGENCE_AI_API_TOKEN);
  if(clientToken===intelligenceToken)throw new Error("ai_gateway_token_reuse");
  const providerApiKey=env.OPENAI_API_KEY;
  const providerModel=env.AI_GATEWAY_MODEL;
  validateModelConfig({apiKey:providerApiKey,model:providerModel});
  return {
    clientToken,intelligenceToken,providerApiKey,providerModel,
    intelligencePort:integerPort(env.INTELLIGENCE_API_PORT??"3182"),
    port:integerPort(env.AI_GATEWAY_PORT??"3183"),
  };
}
export async function startAiGateway(env=process.env){
  const config=gatewayConfiguration(env);
  if(config.port===config.intelligencePort)
    throw new Error("gateway_port_must_differ_from_intelligence");
  const server=createAiGateway(config);
  await new Promise((accept,reject)=>{
    server.once("error",reject);
    server.listen(config.port,"127.0.0.1",()=>{
      server.off("error",reject);accept();
    });
  });
  const shutdown=()=>server.close();
  process.once("SIGTERM",shutdown);
  process.once("SIGINT",shutdown);
  return {server,port:config.port,address:"127.0.0.1"};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  startAiGateway().then(()=>{
    console.log("AI gateway listening on loopback; provider egress explicitly enabled");
  }).catch(()=>{
    console.error("AI gateway refused start: configuration_or_binding_invalid");
    process.exitCode=1;
  });
}
