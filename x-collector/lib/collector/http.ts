import { CollectorActionError } from "./errors";
import { subscribeLive } from "./live";
import fs from "node:fs/promises";
import path from "node:path";
import { IncomingMessage, ServerResponse } from "node:http";
import { ZodError } from "zod";
import { checkOrigin } from "../trade/http-security";
import { readiness, startCollection, taskDetails, resumeCollection } from "./control";
export async function handleCollectorRequest(req:IncomingMessage,res:ServerResponse,origin:string,services={readiness,startCollection,taskDetails,resumeCollection}):Promise<boolean> {
 const url=new URL(req.url??"/","http://localhost");
 if(!["/collector","/collector.js"].includes(url.pathname)&&!url.pathname.startsWith("/api/collector/"))return false;
 const json=(status:number,data:unknown)=>{res.statusCode=status;res.setHeader("Content-Type","application/json; charset=utf-8");res.end(JSON.stringify(data));};
 try {
 if(["/api/collector/start","/api/collector/resume"].includes(url.pathname)) {
  if(req.method!=="POST"){res.setHeader("Allow","POST");json(405,{error:"POST required"});return true;}
  const check=checkOrigin(req,origin);if(!check.ok){json(403,{error:"Запуск разрешён только со страницы этого dashboard"});return true;}
  const chunks:Buffer[]=[];let bytes=0;for await(const part of req){const chunk=Buffer.isBuffer(part)?part:Buffer.from(part);bytes+=chunk.length;chunks.push(chunk);if(bytes>8192){json(413,{error:"Слишком большой запрос"});return true;}}
  let data:unknown;try{data=JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{json(400,{error:"Некорректный JSON"});return true;}
  if(url.pathname.endsWith("/resume")){if(typeof data!=="object"||data===null||!("id" in data)||typeof data.id!=="string"){json(400,{error:"ID задания обязателен"});return true;}json(202,await services.resumeCollection(data.id));}else json(202,await services.startCollection(data));return true;
 }
 if(req.method!=="GET"){res.setHeader("Allow","GET");json(405,{error:"GET required"});return true;}
 if(url.pathname==="/api/collector/live"){subscribeLive(res);return true;}
 if(url.pathname==="/api/collector/status"){json(200,await services.readiness());return true;}
 const match=url.pathname.match(/^\/api\/collector\/tasks\/(\d+)$/);
 if(match){const data=await services.taskDetails(match[1]);json(data?200:404,data??{error:"Задание не найдено"});return true;}
 if(url.pathname.startsWith("/api/")){json(404,{error:"Маршрут не найден"});return true;}
 res.setHeader("Content-Type",url.pathname.endsWith(".js")?"application/javascript; charset=utf-8":"text/html; charset=utf-8");
 res.end(await fs.readFile(path.join(process.cwd(),"public",url.pathname.endsWith(".js")?"collector.js":"collector.html")));return true;
 } catch(error) {
  const status=error instanceof ZodError?400:error instanceof CollectorActionError?409:503;
  const message=error instanceof ZodError?"Проверьте запрос, handle, лимит и тип сбора":error instanceof CollectorActionError?error.message:"Не удалось выполнить действие. Проверьте доступность базы и журнал сервера";
  json(status,{error:message});return true;
 }
}
