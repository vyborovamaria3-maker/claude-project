// Browser compatibility and redacted diagnostics; no stealth flags or credential capture.
async function launchLoginBrowser(chromium,env=process.env,extra={}){
 const base={headless:extra.headless??false,...(extra.proxy?{proxy:extra.proxy}:{})};
 if(env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)return {browser:await chromium.launch({...base,executablePath:env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}),label:'Настроенный Chromium'};
 const preferred=env.X_LOGIN_BROWSER;
 if(preferred&&!['chrome','msedge','chromium'].includes(preferred))throw Error('browserconfig');
 const channels=preferred?[preferred]:['chrome','msedge','chromium'];
 for(const channel of channels){try{return {browser:await chromium.launch({...base,...(channel==='chromium'?{}:{channel})}),label:channel==='chrome'?'Google Chrome':channel==='msedge'?'Microsoft Edge':'Chromium'};}catch{/* Try the next supported browser; do not expose paths from launch errors. */}}
 throw Error('browsermissing');
}
function attachLoginDiagnostics(page,report){
 const relevant=url=>{try{const u=new URL(url);return /(^|\.)x\.com$|(^|\.)twitter\.com$/.test(u.hostname)&&/onboarding\/task|i\/flow\/login/.test(u.pathname);}catch{return false;}};
 page.on('requestfailed',request=>{
  if(!relevant(request.url()))return;
  const raw=request.failure()?.errorText||'';
  const code=/^[a-zA-Z0-9_:.-]{1,80}$/.test(raw)?raw:'NETWORK_ERROR';
  report('Запрос входа X не выполнен: '+code+'. Проверьте подключение к X в обычном браузере.');
 });
 page.on('response',async response=>{
  if(!relevant(response.url()))return;
  const status=response.status();
  if(status>=400){report('Сервер X вернул HTTP '+status+' при входе. Аккаунт пока не сохранён.');return;}
  if(status!==200||!response.url().includes('onboarding/task'))return;
  try{const body=await response.json();if(Array.isArray(body?.errors)&&body.errors.length){const code=Number(body.errors[0]?.code);report('X отклонил запрос входа'+(Number.isInteger(code)?' (код '+code+')':'')+'. Проверьте сообщение в окне X.');}}catch{/* Successful non-JSON response does not need a diagnosis. */}
 });
 page.on('pageerror',()=>report('На странице X возникла ошибка JavaScript. Попробуйте обновить окно X; если ошибка повторяется, пришлите этот статус.'));
}
module.exports={launchLoginBrowser,attachLoginDiagnostics};
