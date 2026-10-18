import assert from "node:assert/strict";
import { chromium } from "playwright";
const origin=process.env.TG_COLLECTOR_SMOKE_URL||"http://127.0.0.1:3100";
const browser=await chromium.launch({headless:true});
try{
 const context=await browser.newContext(),page=await context.newPage();
 const endpoint=origin+"/api/integrations/tg-collector";
 assert.equal((await page.request.get(endpoint)).status(),401);
 assert.equal((await page.request.post(endpoint+"/session",{headers:{Origin:"http://evil.invalid","Sec-Fetch-Site":"cross-site"}})).status(),403);
 await page.goto(origin+"/settings?tab=tgcollector",{waitUntil:"domcontentloaded",timeout:120000});
 await page.getByRole("heading",{name:"TG Collector",exact:true}).waitFor();
 assert.equal(await page.getByLabel("Ключ доступа TG Collector").count(),0);
 console.log("Settings auto-connected");
 const snapshot=await page.evaluate(async()=>{const r=await fetch("/api/integrations/tg-collector");if(!r.ok)throw Error("Snapshot denied");return r.json()});
 await page.locator("article").first().waitFor();
 assert.ok(snapshot.messages.length>0);assert.equal(snapshot.workerOnline,true);assert.equal(snapshot.proxy.enabled,true);
 assert.equal("password" in snapshot.proxy,false);assert.equal("username" in snapshot.proxy,false);
 const cookie=(await context.cookies()).find(c=>c.name==="tg_collector_local");assert.ok(cookie?.httpOnly);assert.equal(cookie.sameSite,"Strict");
 assert.equal((await page.evaluate(()=>document.cookie)).includes("tg_collector_local"),false);
 if(!snapshot.collectionEnabled){await page.getByRole("button",{name:"Запустить парсинг",exact:true}).click();await page.waitForFunction(async()=>(await(await fetch("/api/integrations/tg-collector")).json()).collectionEnabled===true);}
 await page.getByRole("button",{name:"Остановить",exact:true}).click();
 await page.waitForFunction(async()=>(await(await fetch("/api/integrations/tg-collector")).json()).collectionEnabled===false);
 console.log("Settings stop applied");
 await page.goto(origin+"/admin/tg-collector",{waitUntil:"domcontentloaded",timeout:120000});
 await page.getByRole("heading",{name:"TG Collector",exact:true}).waitFor();
 assert.equal(await page.getByRole("navigation",{name:"Collector administration"}).getByRole("link",{name:"X Collector",exact:true}).count(),1);
 assert.equal(await page.getByLabel("Ключ доступа TG Collector").count(),0);
 await page.getByRole("button",{name:"Запустить парсинг",exact:true}).click();
 await page.waitForFunction(async()=>(await(await fetch("/api/integrations/tg-collector")).json()).collectionEnabled===true);
 assert.equal((await page.request.post(endpoint,{headers:{Origin:"http://evil.invalid"},data:{action:"stop"}})).status(),403);
 assert.equal((await page.request.get(endpoint+"/graph?days=0")).status(),200);
 await page.reload({waitUntil:"domcontentloaded"});await page.getByRole("heading",{name:"TG Collector",exact:true}).waitFor();
 assert.equal(await page.getByLabel("Ключ доступа TG Collector").count(),0);
 console.log(JSON.stringify({passed:true,messages:snapshot.stats.messages,workerOnline:true,settingsStopAdminStart:true,httpOnlySession:true,foreignOriginBlocked:true}));
}finally{await browser.close()}
