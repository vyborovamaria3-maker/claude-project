(() => {
  const nav = document.querySelector('#xCollectorNav');
  let host;
  if (!nav) return;
  let active = false, generation = 0, page = 1, filter = 'all', data, dirty = false, pending = false;
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const date = v => v ? new Date(Number(v)).toLocaleString('ru-RU') : '—';
  const role = {collector:'Сбор данных',publisher:'Публикации'};
  const status = {active:'Активен',cooldown:'Пауза',captcha:'Нужен вход',banned:'Заблокирован',retired:'Отключён'};
  const kind = {post:'Публикация',reply:'Ответ',repost:'Репост',like:'Лайк',follow:'Подписка',run:'Подготовка решений',discover:'Поиск обсуждений'};
  async function request(path, options={}) {
    const r = await fetch('/api/social-agent'+path,{credentials:'same-origin',...options,headers:{'Content-Type':'application/json'}});
    const body = await r.json();
    if (!r.ok) throw new Error(typeof body.detail==='string'?body.detail:'Проверьте поля формы и подключение.');
    return body;
  }
  function message(text, bad=false) {const el=host.querySelector('#saMessage');if(el){el.textContent=text;el.classList.toggle('sa-error',bad);}}
  async function render(panel = host) {
    host=panel;
    if(!host) return;
    active=true;dirty=false;pending=false;
    document.querySelectorAll('.nav-item').forEach(el=>el.classList.toggle('active',el===nav));
    const ticket=++generation;
    document.querySelector('#viewTitle').textContent='X Collector';
    host.innerHTML='<div class="sa-wrap"><section class="section"><h3>Агент Solana</h3><p role="status">Загружаем настройки и решения…</p></section></div>';
    await load(ticket);
  }
  async function load(ticket=++generation) {
    try {
      const result=await request(`/state?status=${filter}&page=${page}`);
      if(!active||ticket!==generation)return;
      data=result;draw();
    } catch(e) {if(active&&ticket===generation)host.innerHTML=`<section class="section"><h3>Не удалось подключиться к агенту</h3><p role="alert">${esc(e.message)}</p><p class="muted">Проверьте подключение X Collector и миграции до 014. Аккаунты и настройки не изменены.</p><button id="saRetry" class="secondary">Повторить</button></section>`;host.querySelector('#saRetry')?.addEventListener('click',()=>void render());}
  }
  async function mutate(path,body,method='PUT',success='Сохранено') {
    if(pending)return;
    const controls=[...host.querySelectorAll('button,input,select')].map(el=>[el,el.disabled]);
    pending=true;controls.forEach(([el])=>el.disabled=true);message('Сохраняем…');
    const ticket=++generation;
    try {
      await request(path,{method,body:JSON.stringify(body)});
      if(!active||ticket!==generation)return;
      dirty=false;await load(ticket);message(success);
    } catch(e) {if(active&&ticket===generation){message(e.message,true);controls.forEach(([el,disabled])=>el.disabled=disabled);}}
    finally {pending=false;}
  }
  function draw() {
    const s=data.settings, count=data.counts, writers=data.accounts.filter(a=>a.role==='publisher');
    const remaining=Math.max(0,s.max_actions_per_day-Number(count.today));
    const queued=data.commands.filter(c=>c.status==='pending');
    host.innerHTML=`<div class="sa-wrap">
      <section class="section sa-hero"><div><span class="sa-eyebrow">SOLANA · МЕМКОИНЫ</span><h2>Обсуждения → решения агента</h2><p>Сборщик находит темы. Агент выбирает источники и сохраняет решения для отдельных аккаунтов публикации.</p></div><div class="sa-badges"><span class="status-pill ${s.stopped?'warn':'ok'}">${s.stopped?'Остановлен':'Тестовый режим включён'}</span><span class="status-pill">Отправка в X отключена</span></div></section>
      <div class="sa-notice"><strong>Сейчас работает тестовый алгоритм, без ИИ-модели.</strong> Публикации и репосты только моделируются. Ответы, лайки и подписки не выполняются. Подключение модели и отправку настроим отдельно.</div>
      <div class="sa-metrics"><article class="card"><div class="metric-label">Решений сегодня</div><div class="metric-value">${esc(count.today)} <small>/ ${esc(s.max_actions_per_day)}</small></div><div class="metric-sub">Дневной лимит обновляется в 03:00 МСК</div></article><article class="card"><div class="metric-label">Осталось решений</div><div class="metric-value">${remaining}</div><div class="metric-sub">Заблокированные решения тоже учитываются</div></article><article class="card"><div class="metric-label">Аккаунты для публикаций</div><div class="metric-value">${writers.filter(a=>a.status==='active'&&a.tier!=='retired').length}</div><div class="metric-sub">Всего в этом пуле: ${writers.length}</div></article></div>
      <section class="section"><div class="section-head"><div><h3>Управление</h3><p class="muted">Поиск — каждый час. Подготовка решений — каждые 10 минут.</p></div></div><div class="sa-controls"><button id="saStart" class="primary" ${!s.stopped?'disabled':''}>Включить тестовый режим</button><button id="saStop" class="sa-stop" ${s.stopped?'disabled':''}>Остановить агента</button><button id="saDiscover" class="secondary" ${s.stopped||queued.some(c=>c.kind==='discover')?'disabled':''}>Найти обсуждения сейчас</button><button id="saRun" class="secondary" ${s.stopped||!writers.length||!remaining||queued.some(c=>c.kind==='run')?'disabled':''}>Подготовить решения</button><button id="saRefresh" class="secondary">Обновить</button></div><p id="saMessage" role="status" aria-live="polite">${s.stopped?'Агент остановлен. Включение запускает только тестовый режим.':'Команды выполняет запущенный планировщик. Ожидание больше минуты — проверьте scheduler.'}</p>${writers.length?'':'<p class="sa-warning">Нет аккаунтов Publisher. Назначьте роль «Публикации» одному из отдельных аккаунтов ниже.</p>'}<p class="muted">Остановка прекращает новые циклы после текущего. Уже поставленные задачи сбора остаются в очереди.</p>${data.commands.length?`<div class="sa-jobs">${data.commands.map(c=>`<div><strong>${esc(kind[c.kind])}</strong><span>${esc(({pending:'Ожидает планировщик',done:'Выполнено',failed:'Ошибка'})[c.status])} · ${date(c.created_at)}</span>${c.result?`<small>${esc(c.result.status==='no-publisher'?'Нет доступного аккаунта публикаций':c.result.status==='stopped'?'Агент остановлен':c.result.status==='busy'?'Другой цикл уже выполняется':c.result.status==='budget-exhausted'?'Дневной лимит исчерпан':c.result.queued!==undefined?'Задач поиска: '+c.result.queued:'Решений сохранено: '+(c.result.actions??0))}</small>`:''}${c.error?`<small>${esc(c.error)}</small>`:''}</div>`).join('')}</div>`:''}</section>
      <div class="sa-columns"><section class="section"><h3>Лимиты</h3><p class="muted">Общие для всех аккаунтов публикации.</p><form id="saLimits" class="sa-form"><label>Решений за один цикл<input id="saCycle" type="number" min="1" max="10" required value="${s.max_actions_per_cycle}"><small>От 1 до 10</small></label><label>Решений в день<input id="saDay" type="number" min="1" max="100" required value="${s.max_actions_per_day}"><small>От 1 до 100</small></label><button class="primary">Сохранить лимиты</button></form></section><section class="section"><h3>Аккаунты и роли</h3><p class="muted">Используйте разные реальные аккаунты X для сбора и публикаций. Секреты здесь не отображаются.</p>${data.accounts.length?data.accounts.map((a,i)=>`<div class="sa-account"><div><strong>${esc(a.name)}</strong><small>${esc(status[a.status]||a.status)} · ${esc(role[a.role])}</small></div><label class="sa-role"><span class="sa-sr">Роль ${esc(a.name)}</span><select data-role="${i}" aria-label="Роль ${esc(a.name)}"><option value="collector" ${a.role==='collector'?'selected':''}>Сбор данных</option><option value="publisher" ${a.role==='publisher'?'selected':''}>Публикации</option></select></label><button data-save-role="${i}" class="secondary">Сохранить</button></div>`).join(''):'<div class="empty">Аккаунтов пока нет. Добавьте их через вход X Collector, затем вернитесь сюда.</div>'}</section></div>
      <section class="section"><div class="section-head"><div><h3>Журнал решений</h3><p class="muted">Что выбрано, почему и на каком источнике основано.</p></div><label><span class="sa-sr">Фильтр решений</span><select id="saFilter"><option value="all" ${filter==='all'?'selected':''}>Все решения</option><option value="simulated" ${filter==='simulated'?'selected':''}>Симуляции</option><option value="blocked" ${filter==='blocked'?'selected':''}>Заблокированные</option></select></label></div>${data.actions.length?data.actions.map(a=>`<article class="sa-decision"><div class="sa-decision-head"><strong>${esc(kind[a.kind]||a.kind)}</strong><span class="status-pill ${a.status==='blocked'?'warn':'ok'}">${a.status==='blocked'?'Заблокировано':'Симуляция'}</span><time>${date(a.created_at)}</time></div><p>${esc(a.reason)}</p>${a.content?`<blockquote>${esc(a.content)}</blockquote>`:''}<div class="sa-source"><span>Аккаунт: ${esc(a.account_name)}</span><a target="_blank" rel="noopener noreferrer" href="https://x.com/i/status/${encodeURIComponent(a.tweet_id)}">Открыть источник ↗</a></div><details><summary>Данные источника и алгоритм</summary><p>Автор: ${esc(a.evidence?.handle)} · Алгоритм: ${esc(a.provider)}</p><p>${esc(a.evidence?.text)}</p></details></article>`).join(''):'<div class="empty"><strong>Решений пока нет</strong><p>Включите тестовый режим, найдите обсуждения и подготовьте решения. Для сбора нужен worker, для выполнения команд — scheduler.</p></div>'}<div class="pagination"><span>Записей: ${esc(data.total)} · Страница ${page}</span><div><button id="saPrev" ${page===1?'disabled':''}>Назад</button><button id="saNext" ${page*data.page_size>=data.total?'disabled':''}>Далее</button></div></div></section></div>`;
    host.querySelector('#saStart').onclick=()=>mutate('/control',{stopped:false},'PUT','Тестовый режим включён.');
    host.querySelector('#saStop').onclick=()=>mutate('/control',{stopped:true},'PUT','Агент остановлен.');
    host.querySelector('#saDiscover').onclick=()=>mutate('/commands',{kind:'discover'},'POST','Поиск поставлен в очередь планировщика.');
    host.querySelector('#saRun').onclick=()=>mutate('/commands',{kind:'run'},'POST','Подготовка решений поставлена в очередь.');
    host.querySelector('#saRefresh').onclick=()=>{dirty=false;void load();};
    host.querySelector('#saLimits').oninput=()=>{dirty=true;};
    host.querySelector('#saLimits').onsubmit=e=>{e.preventDefault();void mutate('/limits',{per_cycle:Number(host.querySelector('#saCycle').value),per_day:Number(host.querySelector('#saDay').value),version:s.version});};
    host.querySelectorAll('[data-save-role]').forEach(b=>b.onclick=()=>{const i=Number(b.dataset.saveRole),a=data.accounts[i];void mutate('/accounts/'+encodeURIComponent(a.name)+'/role',{role:host.querySelector(`[data-role="${i}"]`).value,version:a.version});});
    host.querySelectorAll('[data-role]').forEach(el=>el.onchange=()=>{dirty=true;});
    host.querySelector('#saFilter').onchange=e=>{filter=e.target.value;page=1;void load();};
    host.querySelector('#saPrev').onclick=()=>{page--;void load();};host.querySelector('#saNext').onclick=()=>{page++;void load();};
  }
  window.SocialAgent=Object.freeze({render,deactivate:()=>{active=false;++generation;}});
  document.querySelector('#navigation').addEventListener('click',e=>{if(e.target.closest('button')!==nav){active=false;++generation;}});
  document.querySelector('#logoutButton').addEventListener('click',()=>{active=false;++generation;},true);
  document.querySelector('#refreshButton').addEventListener('click',e=>{if(active){e.stopImmediatePropagation();dirty=false;void load();}},true);
  setInterval(()=>{if(active&&!dirty&&!pending&&data?.commands.some(c=>c.status==='pending'))void load();},10000);
})();
