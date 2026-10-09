import { CollectorActionError } from "./errors";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn, ChildProcess } from "node:child_process";
import { q } from "../trade/pg";
let child: ChildProcess | null = null;
let starting: Promise<void> | null = null;
let lastError: string | null = null;
export function runtimeStatus() { return { managed: Boolean(child), starting: Boolean(starting), lastError }; }
export async function ensureWorker() {
  if (starting) return starting;
  if (child && child.exitCode === null) return;
  starting = (async () => {
    const active = await q("SELECT id FROM x_workers WHERE status='active' AND last_heartbeat>$1 LIMIT 1", [Date.now()-90000]);
    if (active.length) return;
    if (process.env.COLLECTOR_AUTOSTART === "false") throw new CollectorActionError("Worker не запущен; включите COLLECTOR_AUTOSTART или запустите npm run worker");
    const js = path.resolve(__dirname,"../../scripts/worker.js"), ts = path.resolve(__dirname,"../../scripts/worker.ts");
    const compiled = await fs.access(js).then(()=>true,()=>false);
    const proc = spawn(process.execPath, compiled ? [js] : ["--import","tsx",ts], {
      cwd:process.cwd(), env:{...process.env,WORKER_ID:"dashboard-"+randomUUID(),PG_POOL_MAX:"3",METRICS_HOST:"127.0.0.1",METRICS_PORT:"0"},
      stdio:["ignore","inherit","inherit","ipc"],
    });
    child=proc; lastError=null;
    proc.once("error",()=>{if(child===proc)child=null;lastError="Не удалось запустить процесс worker";});
    proc.once("exit", (code,signal)=>{ if(child===proc)child=null; if(code!==0)lastError=`Worker остановился (${signal??code})`; });
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>{proc.kill("SIGTERM");done(new CollectorActionError("Worker не подтвердил запуск за 15 секунд"));},15000);
      const ready=(message:unknown)=>{if(typeof message==="object"&&message!==null&&"ready" in message&&message.ready===true)done();};
      const failed=()=>done(new CollectorActionError("Worker завершился до готовности; проверьте журнал"));
      const done=(error?:Error)=>{clearTimeout(timer);proc.off("message",ready);proc.off("exit",failed);proc.off("error",failed);if(error){lastError=error.message;reject(error);}else resolve();};
      proc.on("message",ready);proc.once("exit",failed);proc.once("error",failed);
    });
  })();
  try { await starting; } finally { starting=null; }
}
export async function stopManagedWorker() {
 const proc=child;if(!proc)return;
 await new Promise<void>(resolve=>{const timer=setTimeout(()=>{proc.kill("SIGKILL");resolve();},45000);proc.once("exit",()=>{clearTimeout(timer);resolve();});proc.kill("SIGTERM");});
}
