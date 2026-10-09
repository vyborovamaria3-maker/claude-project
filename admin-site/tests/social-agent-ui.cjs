const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {chromium}=require(path.resolve(__dirname,'../../x-collector/node_modules/playwright'));
const root=path.resolve(__dirname,'../app/static');
const fixture={settings:{stopped:true,max_actions_per_cycle:3,max_actions_per_day:12,version:'1'},accounts:[{name:'reader',role:'collector',status:'active',tier:'new',version:'1'},{name:'writer',role:'publisher',status:'active',tier:'new',version:'2'}],counts:{today:2,simulated:1,blocked:1},commands:[],actions:[{id:1,kind:'post',status:'simulated',account_name:'writer',tweet_id:'123',created_at:Date.now(),content:'Обсуждение мемкоинов Solana. Источник для самостоятельной проверки.',reason:'Выбрано недавнее обсуждение автора с высокой репутацией.',provider:'deterministic-preview',evidence:{handle:'solana_source',text:'<img src=x onerror="window.injected=true"> Solana memecoin'}},{id:2,kind:'like',status:'blocked',account_name:'writer',tweet_id:'456',created_at:Date.now(),reason:'Автоматические лайки отключены; рекомендация сохранена.',provider:'deterministic-preview',evidence:{handle:'author',text:'Обсуждение запуска мемкоина на Solana'}}],total:2,page:1,page_size:20};
(async()=>{
 const binary=process.env.UI_CHROMIUM_MODULE?(await import(process.env.UI_CHROMIUM_MODULE)).default:null;
 const browser=await chromium.launch(binary?{headless:true,executablePath:await binary.executablePath(),args:binary.args}:{headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1100}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('http://preview.test/**',async route=>{
  const u=new URL(route.request().url());
  if(u.pathname.startsWith('/api/x-collector/tables')){
   const table={name:'twitter_tweets',label:'Твиты',description:'Собранные обсуждения',editable:false,columns:[{name:'text',type:'text'}]};
   return route.fulfill({json:u.pathname.endsWith('/tables')?{tables:[table]}:{table,rows:[{text:'Solana memecoin'}],total:1}});
  }
  if(u.pathname.startsWith('/api/social-agent')){
   if(route.request().method()!=='GET'){
    const body=route.request().postDataJSON();
    if(u.pathname.endsWith('/control'))fixture.settings.stopped=body.stopped;
    if(u.pathname.endsWith('/limits')){fixture.settings.max_actions_per_cycle=body.per_cycle;fixture.settings.max_actions_per_day=body.per_day;}
    if(u.pathname.endsWith('/commands'))fixture.commands.push({id:1,kind:body.kind,status:'pending',created_at:Date.now()});
    return route.fulfill({json:{ok:true,id:1}});
   }
   return route.fulfill({json:fixture});
  }
  if(u.pathname.startsWith('/static/')){const p=root+'/'+u.pathname.split('/').pop();return route.fulfill({body:fs.readFileSync(p),contentType:p.endsWith('.css')?'text/css':'text/javascript'});}
  let html=fs.readFileSync(root+'/index.html','utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');
  html=html.replace('</body>','<script src="/static/x-collector-ui.js"></script><script src="/static/social-agent-ui.js"></script><script>document.querySelector("#loginView").classList.add("hidden");document.querySelector("#appView").classList.remove("hidden");window.XCollector.render();</script></body>');
  return route.fulfill({body:html,contentType:'text/html'});
 });
 await page.goto('http://preview.test');await page.locator('#xcTable').waitFor();
 assert.equal(await page.locator('#socialAgentNav').count(),0);
 await page.locator('#xcAgentTab').click();await page.getByRole('heading',{name:'Обсуждения → решения агента'}).waitFor();
 assert.equal(await page.locator('#saRun').isDisabled(),true);
 assert.equal(await page.locator('#viewTitle').textContent(),'X Collector');
 assert.equal(await page.locator('#xCollectorNav').evaluate(el=>el.classList.contains('active')),true);
 await page.locator('#xcDatabaseTab').click();await page.locator('#xcTable').waitFor();
 await page.locator('#xcAgentTab').click();await page.locator('#saRun').waitFor();
 assert.equal(await page.locator('#xcAgentTab').getAttribute('aria-selected'),'true');
 await page.screenshot({path:'/tmp/social-agent-desktop.png',fullPage:true});
 await page.locator('#saStart').click();await page.getByText('Тестовый режим включён.',{exact:true}).waitFor();
 await page.locator('#saCycle').fill('5');await page.locator('#saDay').fill('20');await page.locator('#saLimits button').click();await page.getByText('Сохранено',{exact:true}).waitFor();assert.equal(fixture.settings.max_actions_per_cycle,5);
 await page.locator('#saRun').click();await page.getByText('Подготовка решений поставлена в очередь.',{exact:true}).waitFor();assert.equal(await page.locator('#saRun').isDisabled(),true);
 await page.locator('#saStop').click();await page.getByText('Агент остановлен.',{exact:true}).waitFor();assert.equal(fixture.settings.stopped,true);
 await page.locator('details').first().click();assert.equal(await page.evaluate(()=>window.injected),undefined);
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'/tmp/social-agent-mobile.png',fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
 assert.deepEqual(errors,[]);console.log('PASS desktop, mobile, start/stop, limits, queued command, disabled state and escaped source text');
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
