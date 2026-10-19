const {recordAttemptFailure}=require('./audit-error.cjs');
const {fingerprints}=require('./fingerprint.cjs');
const {recordAccountError}=require('../account-health.cjs');
const {failure:breakerFailure,success:breakerSuccess}=require('./breaker.cjs');
const {MAX_PRE_SEND_RETRIES,classifyPreSendError,shouldRetryBeforeSend,retryDelayMs}=require('./publish-retry.cjs');
const {findMatches,expandTweetUrls,INITIAL_CHECK_DELAY_MS,RECONCILIATION_WINDOW_MS,classifyActionState}=require('./reconciliation.cjs');
const {chromium}=require('playwright');const {launchLoginBrowser}=require('../test-publish-browser.cjs');const {parseProxy}=require('../x-proxy.cjs');const {unseal,config}=require('./runtime.cjs');
async function open(c,name,expected){const a=(await c.query("SELECT session_encrypted,proxy_json,last_check_json,last_check_at,user_agent,timezone,language FROM x_accounts WHERE name=$1 AND role='publisher' AND status='active'",[name])).rows[0];if(!a)throw Error('Аккаунт неактивен или удалён');if((a.last_check_json?.steps?.session?.status==='failed'||a.last_check_json?.errorType==='SESSION_EXPIRED'))throw Error('SESSION_EXPIRED');let metadata;try{metadata=JSON.parse(a.proxy_json||'null');}catch{metadata=null;}if(metadata?.status==='failed'&&Date.now()-Number(metadata.last_check)<300000)throw Error('PROXY_FAILED');const parsedProxy=parseProxy(a.proxy_json);if(a.proxy_json&&!parsedProxy)throw Error('PROXY_FAILED');const b=await launchLoginBrowser(chromium,{...process.env,...config()},{proxy:parsedProxy});try{const context=await b.browser.newContext({storageState:JSON.parse(unseal(a.session_encrypted)),userAgent:a.user_agent||undefined,timezoneId:a.timezone||undefined,locale:a.language||undefined});const page=await context.newPage();await page.goto('https://x.com/home',{waitUntil:'domcontentloaded',timeout:45000});const profile=page.locator('[data-testid="AppTabBar_Profile_Link"]').first();await profile.waitFor({timeout:30000});if((await profile.getAttribute('href'))?.replace(/^\//,'').toLowerCase()!==expected)throw Error('Профиль сессии не совпал с username');return {browser:b.browser,page};}catch(e){await b.browser.close();throw e;}}
function extract(body,id){const stack=[body];let n=0;while(stack.length&&n++<30000){const v=stack.pop();if(!v||typeof v!=='object')continue;if(v.rest_id===id&&v.legacy?.full_text){const l=v.legacy;const metric=x=>/^\d{1,19}$/.test(String(x??''))&&BigInt(x)<=9223372036854775807n?String(x):null;return {text:l.full_text,handle:v.core?.user_results?.result?.legacy?.screen_name||v.core?.user_results?.result?.core?.screen_name,posted_at:Date.parse(l.created_at),views:metric(v.views?.count),likes:metric(l.favorite_count),replies:metric(l.reply_count),retweets:metric(l.retweet_count)};}for(const x of Object.values(v))if(typeof x==='object')stack.push(x);}return null;}

function extractTimelineTweets(body){const stack=[body],tweets=new Map();let n=0;while(stack.length&&n++<50000){const v=stack.pop();if(!v||typeof v!=='object')continue;const id=String(v.rest_id||'');const legacy=v.legacy;if(/^\d{1,25}$/.test(id)&&legacy&&typeof legacy.full_text==='string'){const metric=x=>/^\d{1,19}$/.test(String(x??''))&&BigInt(x)<=9223372036854775807n?String(x):null;const handle=v.core?.user_results?.result?.legacy?.screen_name||v.core?.user_results?.result?.core?.screen_name||v.legacy?.user?.screen_name;const posted=Date.parse(legacy.created_at||'');tweets.set(id,{tweet_id:id,handle:handle||null,text:expandTweetUrls(legacy),in_reply_to_tweet_id:legacy.in_reply_to_status_id_str||null,posted_at:Number.isFinite(posted)?posted:null,views:metric(v.views?.count),likes:metric(legacy.favorite_count),replies:metric(legacy.reply_count),retweets:metric(legacy.retweet_count)});}for(const value of Object.values(v))if(value&&typeof value==='object')stack.push(value);}return [...tweets.values()];}

async function persistPostTx(c,job,id,data={}){const timestamp=Number((BigInt(id)>>22n)+1288834974657n);const values=[id,job.account_name,job.expected_handle,data.text||job.content||'',`https://x.com/${job.expected_handle}/status/${id}`,Number.isFinite(data.posted_at)?data.posted_at:timestamp,data.views??null,data.likes??null,data.replies??null,data.retweets??null,Date.now()];const saved=(await c.query(`INSERT INTO xc_auto_posts(tweet_id,account_name,handle,text,url,posted_at,views,likes,replies,retweets,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(tweet_id) DO UPDATE SET views=COALESCE(excluded.views,xc_auto_posts.views),likes=COALESCE(excluded.likes,xc_auto_posts.likes),replies=COALESCE(excluded.replies,xc_auto_posts.replies),retweets=COALESCE(excluded.retweets,xc_auto_posts.retweets),updated_at=excluded.updated_at RETURNING views,likes,replies,retweets`,values)).rows?.[0]||data;
 if(Object.values(data).some(v=>v!==undefined)&&[data.views,data.likes,data.replies,data.retweets].some(v=>v!==null&&v!==undefined))await c.query('INSERT INTO xc_auto_metrics(tweet_id,measured_at,views,likes,replies,retweets) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',[id,Date.now(),saved.views??null,saved.likes??null,saved.replies??null,saved.retweets??null]);
 // Keep existing collector analytics compatible; unknown metrics remain explicit in xc_auto_posts.
 await c.query(`INSERT INTO twitter_tweets(tweet_id,handle,text,url,posted_at,first_seen_at,updated_at,source_query,views,likes,replies,retweets) VALUES($1,$2,$3,$4,$5,$6,$6,'publisher',$7,$8,$9,$10) ON CONFLICT(tweet_id) DO UPDATE SET views=CASE WHEN $11 THEN excluded.views ELSE twitter_tweets.views END,likes=CASE WHEN $12 THEN excluded.likes ELSE twitter_tweets.likes END,replies=CASE WHEN $13 THEN excluded.replies ELSE twitter_tweets.replies END,retweets=CASE WHEN $14 THEN excluded.retweets ELSE twitter_tweets.retweets END,updated_at=excluded.updated_at`,[id,job.expected_handle,data.text||job.content||'',values[4],values[5],values[10],data.views??0,data.likes??0,data.replies??0,data.retweets??0,data.views!=null,data.likes!=null,data.replies!=null,data.retweets!=null]);
 await c.query("UPDATE x_accounts SET publisher_handle=$2,updated_at=GREATEST(updated_at+1,$3::bigint) WHERE name=$1 AND role='publisher'",[job.account_name,job.expected_handle,Date.now()]);}
async function persistPost(c,job,id,data={}){await c.query('BEGIN');try{await persistPostTx(c,job,id,data);await c.query('COMMIT');}catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}}

function extractUser(body,handle){const stack=[body];let n=0;while(stack.length&&n++<30000){const v=stack.pop();if(!v||typeof v!=='object')continue;const username=v.legacy?.screen_name||v.core?.screen_name;if(username?.toLowerCase()===handle.toLowerCase()&&/^\d+$/.test(v.rest_id||''))return v.rest_id;for(const value of Object.values(v))if(value&&typeof value==='object')stack.push(value);}return null;}
async function execute(c,job){let browser,attempted=false,article,followArea,confirmedTweetId=null;try{const opened=await open(c,job.account_name,job.expected_handle);browser=opened.browser;const page=opened.page;let button,responsePromise;
 if(job.kind==='post'){await page.goto('https://x.com/compose/post',{waitUntil:'domcontentloaded',timeout:45000});await page.locator('[data-testid="tweetTextarea_0"]').first().fill(job.content);button=page.locator('[data-testid="tweetButton"]').first();}
 else {await page.goto(`https://x.com/${job.target_handle}/status/${job.target_id}`,{waitUntil:'domcontentloaded',timeout:45000});article=page.locator('article').filter({has:page.locator(`a[href$="/status/${job.target_id}"]`)}).first();await article.waitFor({timeout:25000});const permalink=await article.locator('a').filter({has:page.locator('time')}).first().getAttribute('href');if(!permalink||new URL(permalink,'https://x.com').pathname.split('/').at(-1)!==job.target_id)throw Error('Целевой пост не подтверждён');if(job.kind==='reply'){await article.locator('[data-testid="reply"]').click();await page.locator('[data-testid="tweetTextarea_0"]').first().fill(job.content);button=page.locator('[data-testid="tweetButton"]').first();}
 else if(job.kind==='like'){if(await article.locator('[data-testid="unlike"]').count()){await done(c,job,null,'Уже отмечено лайком');return;}button=article.locator('[data-testid="like"]');}
 else if(job.kind==='repost'){if(await article.locator('[data-testid="unretweet"]').count()){await done(c,job,null,'Уже репостнуто');return;}await article.locator('[data-testid="retweet"]').click();button=page.locator('[data-testid="retweetConfirm"]');}
 else if(job.kind==='follow'){let userId=null;const listener=async r=>{try{if(r.status()===200&&r.url().includes('/graphql/'))userId=extractUser(await r.json(),job.target_handle)||userId;}catch{}};page.on('response',listener);await page.goto('https://x.com/'+job.target_handle,{waitUntil:'domcontentloaded',timeout:45000});const deadline=Date.now()+15000;while(!userId&&Date.now()<deadline)await page.waitForTimeout(250);page.off('response',listener);if(!userId)throw Error('Не удалось подтвердить ID целевого профиля');followArea=page.locator('[data-testid="primaryColumn"]');if(await followArea.locator(`[data-testid="${userId}-unfollow"]`).count()){await done(c,job,null,'Уже подписан');return;}button=followArea.locator(`[data-testid="${userId}-follow"]`).first();followArea=followArea.locator(`[data-testid="${userId}-unfollow"]`);}}

 await button.waitFor({timeout:20000});const enabledDeadline=Date.now()+15000;while(!await button.isEnabled()){if(Date.now()>enabledDeadline)throw Error('Кнопка действия недоступна');await page.waitForTimeout(250);}
 if(['post','reply'].includes(job.kind))responsePromise=page.waitForResponse(r=>r.request().method()==='POST'&&/\/CreateTweet$/.test(new URL(r.url()).pathname),{timeout:45000}).then(async r=>({ok:r.ok(),body:await r.json()})).catch(()=>null);
 // Persist the irreversible boundary before the click, including cancellation/pause checks.
 const {contentHash:boundaryHash,legacyDedup:boundaryLegacy}=fingerprints(job);
 const attemptNow=Date.now();const updated=await c.query(`UPDATE xc_auto_jobs SET attempted=true,attempted_at=$3 WHERE id=$1 AND status='running' AND EXISTS(SELECT 1 FROM x_accounts a WHERE a.name=$2 AND a.role='publisher' AND a.status='active' AND COALESCE(a.account_busy_until,0)>$3) AND NOT EXISTS(SELECT 1 FROM xc_auto_jobs other JOIN xc_auto_jobs current ON current.id=$1
 WHERE other.id<>current.id AND other.account_name=current.account_name AND other.kind=current.kind
 AND (other.content_hash IN ($5,$6) OR other.dedup=$6)
 AND other.attempted AND other.status IN ('running','uncertain'))
 AND (origin='manual' OR (NOT (SELECT paused FROM xc_auto_control WHERE id=1) AND EXISTS(SELECT 1 FROM xc_auto_config f WHERE f.account_name=$2 AND f.enabled AND (f.start_hour=f.end_hour OR (f.start_hour<f.end_hour AND extract(hour FROM to_timestamp($3/1000.0) AT TIME ZONE 'Europe/Moscow')>=f.start_hour AND extract(hour FROM to_timestamp($3/1000.0) AT TIME ZONE 'Europe/Moscow')<f.end_hour) OR (f.start_hour>f.end_hour AND (extract(hour FROM to_timestamp($3/1000.0) AT TIME ZONE 'Europe/Moscow')>=f.start_hour OR extract(hour FROM to_timestamp($3/1000.0) AT TIME ZONE 'Europe/Moscow')<f.end_hour))) AND (SELECT count(*) FROM xc_auto_jobs j WHERE j.account_name=$2 AND j.attempted AND COALESCE(j.attempted_at,j.started_at)>=$4)<f.daily_limit))) RETURNING id`,[job.id,job.account_name,attemptNow,Math.floor((attemptNow+10800000)/86400000)*86400000-10800000,boundaryHash,boundaryLegacy]);if(!updated.rowCount)throw Error('Задание остановлено до отправки');attempted=true;await button.click({timeout:15000});
 if(responsePromise){const r=await responsePromise;let result=r?.body?.data?.create_tweet?.tweet_results?.result;if(result?.tweet)result=result.tweet;const id=result?.rest_id;if(!r?.ok||!/^\d+$/.test(id||''))throw Error('Нет подтверждения X');confirmedTweetId=id;await require('./finalize.cjs').finalizePublication(c,job,id,extract(r.body,id)||{},{expectedStatus:'running',message:'Опубликовано в X'});await breakerSuccess(c,'account',job.account_name).catch(()=>{});}
 else{const selector=job.kind==='like'?'[data-testid="unlike"]':job.kind==='repost'?'[data-testid="unretweet"]':'[data-testid$="-unfollow"]';await (job.kind==='follow'?followArea:article.locator(selector).first()).waitFor({timeout:20000});await done(c,job,null,'Действие подтверждено интерфейсом X');}
 }catch(_e){
 const failure=classifyPreSendError(_e);
 const retryCount=Number.isInteger(Number(job.retry_count))?Number(job.retry_count):0;
 const retry=shouldRetryBeforeSend(_e,attempted,retryCount);
 const now=Date.now();
 if(attempted){
  // The X reply may have been committed before the DB client lost its COMMIT acknowledgement.
  // If the durable job is already published, do not open a spurious reconciliation.
  const observedState=await require('./finalize.cjs').inspectPublicationState(c,job.id,confirmedTweetId);
  if(observedState.status==='published'){
   if(confirmedTweetId&&!observedState.matches)throw new Error('Сохранённый ID публикации не совпадает с подтверждённым X; повтор запрещён',{cause:_e});
   return;
  }
  if(require('./audit-error.cjs').classifyAuditError(_e).category!=='DB_ERROR'){
   await recordAccountError(c,job.account_name,_e).catch(()=>{});
   await breakerFailure(c,'account',job.account_name,failure.code).catch(()=>{});
  }
  await c.query('BEGIN');
  try{
   const state=(await c.query('SELECT attempted_at,started_at,created_at FROM xc_auto_jobs WHERE id=$1',[job.id])).rows[0];
   const attemptedAt=Number(state?.attempted_at||state?.started_at||state?.created_at||now);
   const deadlineAt=attemptedAt+RECONCILIATION_WINDOW_MS;
   const supported=['post','reply','like','repost','follow'].includes(job.kind);
   const reconcileStatus=!supported?'manual_review':deadlineAt<=now?'manual_required':'queued';
   const message=!supported?'Результат действия не подтверждён. Проверьте X вручную; повтор запрещён.':deadlineAt<=now?'Результат старше 24 часов и не подтверждён. Проверьте X вручную; повтор запрещён.':'Результат отправки неизвестен; сверка X запланирована. Повторная отправка запрещена.';
   await c.query("UPDATE xc_auto_jobs SET status='uncertain',message=$2,finished_at=$3,lease_until=NULL WHERE id=$1 AND status='running'",[job.id,message,now]);
   await c.query("INSERT INTO xc_auto_reconcile(job_id,account_name,expected_handle,kind,attempted_at,next_check_at,deadline_at,status,last_error,created_at,updated_at,finished_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11) ON CONFLICT(job_id) DO UPDATE SET account_name=excluded.account_name,expected_handle=excluded.expected_handle,kind=excluded.kind,attempted_at=excluded.attempted_at,next_check_at=excluded.next_check_at,deadline_at=excluded.deadline_at,attempts=0,status=excluded.status,matched_tweet_id=NULL,candidates='[]'::jsonb,last_error=excluded.last_error,updated_at=excluded.updated_at,finished_at=excluded.finished_at WHERE xc_auto_reconcile.status='resolved'",[job.id,job.account_name,job.expected_handle,job.kind,attemptedAt,reconcileStatus==='queued'?now+INITIAL_CHECK_DELAY_MS:now,deadlineAt,reconcileStatus,!supported?'Автоматическая сверка этого типа действия не поддерживается.':deadlineAt<=now?'Срок автоматической сверки истёк.':null,now,reconcileStatus==='queued'?null:now]);
   await recordAttemptFailure(c,job.id,_e);
   await c.query('COMMIT');
  }catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}
 }else if(retry){
  const delayMs=retryDelayMs(retryCount);
  const message='Временная ошибка ('+failure.code+'). Повтор '+(retryCount+1)+'/'+MAX_PRE_SEND_RETRIES+' через '+Math.round(delayMs/1000)+' с.';
  await c.query('BEGIN');
  try{
  await c.query("UPDATE xc_auto_jobs SET status='queued',retry_count=LEAST(retry_count+1,$4),scheduled_at=$2,started_at=NULL,finished_at=NULL,lease_until=NULL,attempted_at=NULL,message=$3 WHERE id=$1 AND status='running' AND attempted=false",[job.id,now+delayMs,message,MAX_PRE_SEND_RETRIES]);
   await recordAttemptFailure(c,job.id,_e);
   await c.query('COMMIT');
  }catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}
 }else{
  if(failure.code!=='JOB_NOT_ELIGIBLE'&&(!failure.retryable||retryCount>=MAX_PRE_SEND_RETRIES)){
   await recordAccountError(c,job.account_name,_e).catch(()=>{});
   await breakerFailure(c,'account',job.account_name,failure.code).catch(()=>{});
  }
  await c.query('BEGIN');
  try{
  await c.query("UPDATE xc_auto_jobs SET status='failed',message=$2,finished_at=$3,lease_until=NULL WHERE id=$1 AND status='running'",[job.id,failure.message,now]);
   await recordAttemptFailure(c,job.id,_e);
   await c.query('COMMIT');
  }catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}
 }
}finally{await browser?.close().catch(()=>{});}}
async function done(c,job,id,message){const saved=await c.query("UPDATE xc_auto_jobs SET status='published',result_id=$2,result_url=$3,message=$4,finished_at=$5,lease_until=NULL WHERE id=$1 AND status='running' RETURNING id",[job.id,id,id?`https://x.com/${job.expected_handle}/status/${id}`:job.kind==='follow'?`https://x.com/${job.target_handle}`:job.target_id?`https://x.com/${job.target_handle}/status/${job.target_id}`:null,message,Date.now()]);if(saved.rowCount===1)await breakerSuccess(c,'account',job.account_name).catch(()=>{});}
async function sync(c,name,expected,id){const opened=await open(c,name,expected);try{const page=opened.page;let found=null;const listener=async r=>{try{if(!r.url().includes('/graphql/')||r.status()!==200)return;const data=extract(await r.json(),id);if(data&&data.handle?.toLowerCase()===expected)found=data;}catch{}};page.on('response',listener);await page.goto(`https://x.com/${expected}/status/${id}`,{waitUntil:'domcontentloaded',timeout:45000});await page.locator(`article a[href$="/status/${id}"]`).first().waitFor({timeout:25000});const deadline=Date.now()+10000;while(!found&&Date.now()<deadline)await page.waitForTimeout(250);if(!found)throw Error('X не вернул метрики поста; существующие данные сохранены');await persistPost(c,{account_name:name,expected_handle:expected,content:found.text},id,found);return {ok:true};}finally{await opened.browser.close();}}

async function reconcilePost(c,job){
 if(!['post','reply'].includes(job.kind))return [];
 const opened=await open(c,job.account_name,job.expected_handle);
 try{
  const page=opened.page,found=new Map(),pending=new Set();
  const listener=response=>{
   const task=(async()=>{
    try{
     if(response.status()!==200||!response.url().includes('/graphql/'))return;
     for(const tweet of extractTimelineTweets(await response.json())){
      if(tweet.handle&&tweet.handle.replace(/^@/,'').toLowerCase()===job.expected_handle.replace(/^@/,'').toLowerCase())found.set(tweet.tweet_id,tweet);
     }
    }catch{}
   })();
   pending.add(task);
   void task.finally(()=>pending.delete(task));
  };
  page.on('response',listener);
  try{
   await page.goto('https://x.com/'+job.expected_handle+(job.kind==='reply'?'/with_replies':''),{waitUntil:'domcontentloaded',timeout:45000});
   await page.locator('article').first().waitFor({timeout:25000});
   await page.waitForTimeout(1200);
   for(let i=0;i<3;i++){await page.evaluate(()=>globalThis.scrollTo(0,globalThis.document.body.scrollHeight));await page.waitForTimeout(900);}
   await page.waitForTimeout(500);
   while(pending.size)await Promise.all([...pending]);
   return findMatches(job,[...found.values()],Date.now());
  }finally{page.off('response',listener);}
 }finally{await opened.browser.close().catch(()=>{});}
}

async function reconcileAction(c,job,opener=open){
 const targetHandle=String(job.target_handle||'').replace(/^@/,'');
 if(!/^[A-Za-z0-9_]{1,15}$/.test(targetHandle))return {status:'unknown'};
 if(job.kind!=='follow'&&!/^[0-9]{1,25}$/.test(String(job.target_id||'')))return {status:'unknown'};
 const opened=await opener(c,job.account_name,job.expected_handle);
 try{
  const page=opened.page;
  if(job.kind==='follow'){
   let userId=null;const pending=new Set();
   const listener=response=>{const task=(async()=>{try{if(response.status()===200&&response.url().includes('/graphql/'))userId=extractUser(await response.json(),targetHandle)||userId;}catch{}})();pending.add(task);void task.finally(()=>pending.delete(task));};
   page.on('response',listener);
   try{
    await page.goto('https://x.com/'+targetHandle,{waitUntil:'domcontentloaded',timeout:45000});
    const area=page.locator('[data-testid="primaryColumn"]');await area.waitFor({timeout:20000});
    const deadline=Date.now()+15000;while(!userId&&Date.now()<deadline)await page.waitForTimeout(250);
    while(pending.size)await Promise.all([...pending]);
    // A renamed, redirected or inaccessible profile is not evidence of a follow.
    const resolvedPath=new URL(page.url()).pathname.replace(/\/$/,'').toLowerCase();
    if(resolvedPath!=='/'+targetHandle.toLowerCase()||!userId)return {status:'unknown'};
    const done=area.locator('[data-testid="'+userId+'-unfollow"]');
    const available=area.locator('[data-testid="'+userId+'-follow"]');
    const doneCount=await done.count(),availableCount=await available.count();
    return {status:classifyActionState('follow',doneCount>0,availableCount>0)};
   }finally{page.off('response',listener);}
  }
  if(!['like','repost'].includes(job.kind))return {status:'unknown'};
  const targetId=String(job.target_id),found=new Map(),pending=new Set();
  const listener=response=>{const task=(async()=>{try{if(response.status()!==200||!response.url().includes('/graphql/'))return;for(const tweet of extractTimelineTweets(await response.json()))if(tweet.tweet_id===targetId)found.set(tweet.tweet_id,tweet);}catch{}})();pending.add(task);void task.finally(()=>pending.delete(task));};
  page.on('response',listener);
  try{
   await page.goto('https://x.com/'+targetHandle+'/status/'+targetId,{waitUntil:'domcontentloaded',timeout:45000});
   const article=page.locator('article').filter({has:page.locator('a[href$="/status/'+targetId+'"]')}).first();
   await article.waitFor({timeout:25000});await page.waitForTimeout(1000);while(pending.size)await Promise.all([...pending]);
   const tweet=found.get(targetId);
   if(!tweet||String(tweet.handle||'').replace(/^@/,'').toLowerCase()!==targetHandle.toLowerCase())return {status:'unknown'};
   const permalink=await article.locator('a').filter({has:page.locator('time')}).first().getAttribute('href');
   if(!permalink||new URL(permalink,'https://x.com').pathname.split('/').at(-1)!==targetId)return {status:'unknown'};
   const done=article.locator(job.kind==='like'?'[data-testid="unlike"]':'[data-testid="unretweet"]');
   const available=article.locator(job.kind==='like'?'[data-testid="like"]':'[data-testid="retweet"]');
   const doneCount=await done.count(),availableCount=await available.count();
   return {status:classifyActionState(job.kind,doneCount>0,availableCount>0)};
  }finally{page.off('response',listener);}
 }finally{await opened.browser.close().catch(()=>{});}
}
module.exports={open,extract,extractUser,persistPost,persistPostTx,execute,sync,extractTimelineTweets,reconcilePost,reconcileAction};
