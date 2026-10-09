(() => {
  const nav = document.querySelector('#xCollectorNav');
  const content = document.querySelector('#content');
  if (!nav || !content) return;
  let active = false, table = '', tables = [], data = null, offset = 0, generation = 0;
  let search = '', sort = '', filterColumn = '', filterValue = '', descending = true;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const labels = {id:'ID',tweet_id:'ID твита',handle:'Автор',mint:'Адрес токена',text:'Текст',views:'Просмотры',likes:'Лайки',retweets:'Репосты',replies:'Ответы',status:'Состояние',kind:'Тип задачи',attempts:'Попытки',last_error:'Последняя ошибка',posted_at:'Опубликован',created_at:'Создан',updated_at:'Обновлён',first_seen_at:'Впервые найден',priority:'Приоритет',payload_json:'Параметры задачи',is_verified:'Верифицирован',url:'Ссылка'};
  Object.assign(labels, {max_attempts:'Максимум попыток',available_at:'Доступна с',claimed_by:'Исполнитель',claimed_at:'Начало выполнения',lease_expires_at:'Аренда до',idempotency_key:'Ключ защиты от дублей',source_query:'Поисковый запрос',linked_at:'Связь создана',failed_at:'Ошибка зафиксирована',published_at:'Отправлено',topic:'Тип события',payload:'Данные события',enabled:'Включено',name:'Название',description:'Описание',display_name:'Отображаемое имя',bio:'Описание профиля',followers:'Подписчики',following:'Подписки',tier:'Уровень',score:'Оценка',weight:'Вес',count:'Количество',total_tweets:'Всего твитов',unique_authors:'Разных авторов',total_views:'Всего просмотров',last_mention_at:'Последнее упоминание',first_mention_at:'Первое упоминание',worker_id:'ID процесса',account_id:'ID аккаунта',last_seen_at:'Последняя активность',heartbeat_at:'Последний сигнал',error:'Ошибка',duration_ms:'Длительность, мс',sentiment:'Тональность',language:'Язык',toxicity:'Токсичность',confidence:'Уверенность',cluster_id:'ID группы',model_id:'ID модели',run_id:'ID запуска',mint_a:'Первый токен',mint_b:'Второй токен'});
  const label = name => labels[name] || name;
  function cell(value, column) {
    if (value === null) return '—';
    if (column==='status') return ({pending:'Ожидает',claimed:'Выполняется',done:'Завершена',failed:'Ошибка',active:'Активен',cooldown:'Пауза',banned:'Заблокирован'}[value] || String(value));
    if (column==='kind') return ({search:'Поиск твитов',timeline:'Лента автора',profile:'Профиль автора'}[value] || String(value));
    if (typeof value === 'boolean') return value ? 'Да' : 'Нет';
    if (/_at$/.test(column) && /^\d{13}$/.test(String(value))) return new Date(Number(value)).toLocaleString('ru-RU');
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
  async function request(path, options = {}) {
    const response = await fetch('/api/x-collector' + path, {credentials:'same-origin', ...options, headers:{'Content-Type':'application/json', ...options.headers}});
    const body = await response.json();
    if (!response.ok) throw new Error(typeof body.detail === 'string' ? body.detail : 'Проверьте введённые данные');
    return body;
  }
  function error(message) { const el = content.querySelector('#xcStatus'); if (el) el.textContent = message; }
  async function render() {
    active = true;
    const ticket = ++generation;
    document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n === nav));
    document.querySelector('#viewTitle').textContent = 'X Collector';
    content.innerHTML = '<section class="section full"><h3>База коллектора</h3><p id="xcStatus">Подключение…</p></section>';
    try {
      const catalog = await request('/tables');
      if (!active || ticket !== generation) return;
      tables = catalog.tables;
      if (!table || !tables.some(t => t.name === table)) table = tables.some(t => t.name === 'twitter_tweets') ? 'twitter_tweets' : tables[0]?.name;
      if (!table) { error('В базе пока нет таблиц. Выполните миграции коллектора.'); return; }
      await load(ticket);
    } catch (e) { if (ticket === generation && active) error(e.message); }
  }
  async function load(ticket = ++generation) {
    const params = new URLSearchParams({limit:50,offset,search,sort,descending,filter_column:filterColumn,filter_value:filterValue});
    try {
      const result = await request('/tables/' + encodeURIComponent(table) + '?' + params);
      if (!active || ticket !== generation) return;
      data = result;
      draw();
    } catch(e) { if (active && ticket === generation) error(e.message); }
  }
  function draw() {
    const columns = data.table.columns;
    const publicColumns = columns.filter(c => !c.sensitive && !['json','jsonb'].includes(c.type) && !c.name.endsWith('_json'));
    const canEdit = data.table.editable && columns.some(c => c.primary_key);
    content.innerHTML = `<section class="section full"><h3>${esc(data.table.label)}</h3>
      <p class="muted">${esc(data.table.description)}</p><p class="muted">Вся база X Collector: таблицы содержат исходные данные, очереди и результаты анализа. Секреты скрыты. Представления — вычисляемые данные, доступные для чтения.</p>
      <form id="xcFilters" class="stack"><label>Раздел базы<select id="xcTable">${tables.map(t=>`<option value="${esc(t.name)}" ${t.name===table?'selected':''}>${esc(t.label)} · ${esc(t.name)}${['v','m'].includes(t.kind)?' (представление)':''}</option>`).join('')}</select></label>
      <label>Поиск по открытым полям<input id="xcSearch" value="${esc(search)}" placeholder="Автор, адрес токена, текст, ошибка…"></label>
      <label>Точное совпадение по полю<select id="xcFilterColumn"><option value="">Все поля</option>${publicColumns.map(c=>`<option value="${esc(c.name)}" ${c.name===filterColumn?'selected':''}>${esc(label(c.name))}</option>`).join('')}</select><input id="xcFilterValue" value="${esc(filterValue)}" placeholder="Например: pending"></label>
      <label>Сортировка<select id="xcSort"><option value="">По первичному ключу</option>${publicColumns.map(c=>`<option value="${esc(c.name)}" ${c.name===sort?'selected':''}>${esc(label(c.name))}</option>`).join('')}</select></label>
      <label><input type="checkbox" id="xcDescending" ${descending?'checked':''}> По убыванию</label><button class="secondary">Применить</button></form>
      <p id="xcStatus" role="status">Найдено записей: ${esc(data.total)}. Показано ${data.rows.length ? offset+1 : 0}–${offset+data.rows.length}.</p>
      ${data.table.editable?'<button id="xcAdd" class="primary">Добавить запись</button>':''}
      <div style="overflow:auto;margin-top:16px"><table><thead><tr><th>Действия</th>${columns.map(c=>`<th title="${esc(c.name+' · '+c.type)}">${esc(label(c.name))}${c.primary_key?' 🔑':''}</th>`).join('')}</tr></thead><tbody>${data.rows.map((r,i)=>`<tr><td><button data-record="${i}">${canEdit?'Открыть / изменить':'Подробнее'}</button></td>${columns.map(c=>`<td title="${esc(cell(r[c.name],c.name))}">${esc(cell(r[c.name],c.name).slice(0,180))}</td>`).join('')}</tr>`).join('')||`<tr><td colspan="${columns.length+1}">Записей нет. Измените фильтры или запустите сбор.</td></tr>`}</tbody></table></div>
      <div style="display:flex;gap:12px;margin-top:16px"><button id="xcPrev" ${offset===0?'disabled':''}>Назад</button><button id="xcNext" ${offset+50>=data.total?'disabled':''}>Далее</button></div>
      <div id="xcEditor"></div></section>`;
    content.querySelector('#xcTable').onchange = e => {table=e.target.value; offset=0;search='';sort='';filterColumn='';filterValue='';void load();};
    content.querySelector('#xcFilters').onsubmit = e => {e.preventDefault();search=content.querySelector('#xcSearch').value;sort=content.querySelector('#xcSort').value;filterColumn=content.querySelector('#xcFilterColumn').value;filterValue=content.querySelector('#xcFilterValue').value;descending=content.querySelector('#xcDescending').checked;offset=0;void load();};
    content.querySelector('#xcPrev').onclick = () => {offset=Math.max(0,offset-50);void load();};
    content.querySelector('#xcNext').onclick = () => {offset+=50;void load();};
    content.querySelector('#xcAdd')?.addEventListener('click',()=>editor(null));
    content.querySelectorAll('[data-record]').forEach(b=>b.onclick=()=>editor(data.rows[Number(b.dataset.record)]));
  }
  function editor(row) {
    const host = content.querySelector('#xcEditor');
    const columns = data.table.columns;
    const writable = data.table.editable && (!row || columns.some(c=>c.primary_key));
    const editable = c => writable && !c.sensitive && !row?.__protected_fields?.includes(c.name) && !c.generated && c.identity!=='a' && (!row || !c.primary_key);
    host.innerHTML = `<form id="xcEditForm" class="stack" style="margin-top:24px"><h3>${row?'Карточка записи':'Новая запись'}</h3><p class="muted">Отметьте только поля, которые хотите записать. Числа вводятся без разделителей; JSON — в виде объекта или массива. Время в полях *_at хранится в миллисекундах Unix. Неотмеченные поля сохраняют текущее значение или значение по умолчанию.</p>${columns.map((c,i)=>`<label>${esc(label(c.name))} <small>${esc(c.name+' · '+c.type)}${c.nullable?' · допускается NULL':' · обязательное'}</small>${editable(c)?`<span><input type="checkbox" data-use="${i}"> Записать поле <input type="checkbox" data-null="${i}"> NULL</span><textarea data-field="${i}" rows="2">${esc(row&&row[c.name]!=null ? (typeof row[c.name]==='object'?JSON.stringify(row[c.name],null,2):row[c.name]) : '')}</textarea>`:`<pre style="white-space:pre-wrap">${esc(row?cell(row[c.name],c.name):'Автоматическое или защищённое поле')}</pre>`}</label>`).join('')}<p id="xcEditStatus" role="status"></p>${writable?'<button type="submit" class="primary">Сохранить</button>':''}${row&&writable?'<button type="button" id="xcDelete">Удалить запись</button>':''}<button type="button" id="xcClose">Закрыть карточку</button></form>`;
    host.scrollIntoView({behavior:'smooth',block:'start'});
    host.querySelector('#xcClose').onclick=()=>{host.innerHTML='';};
    async function save(method) {
      const values = {}, key = {};
      const status = host.querySelector('#xcEditStatus');
      try {
        if (method!=='DELETE') for (const [i,c] of columns.entries()) {
          if (!host.querySelector(`[data-use="${i}"]`)?.checked) continue;
          if (host.querySelector(`[data-null="${i}"]`).checked) {if (!c.nullable) throw new Error(c.name+': NULL недопустим');values[c.name]=null;continue;}
          const raw=host.querySelector(`[data-field="${i}"]`).value;
          if (['json','jsonb'].includes(c.type)) values[c.name]=JSON.parse(raw);
          else if (c.type==='boolean') {if (!['true','false'].includes(raw)) throw new Error(c.name+': введите true или false');values[c.name]=raw==='true';}
          else values[c.name]=raw;
        }
        if(row) columns.filter(c=>c.primary_key).forEach(c=>{key[c.name]=row[c.name];});
        if(!window.confirm(method==='DELETE'?'Удалить эту запись? Связанные данные могут быть удалены по правилам базы.':'Сохранить изменения в базе коллектора?')) return;
        host.querySelectorAll('button').forEach(b=>b.disabled=true);
        await request('/tables/'+encodeURIComponent(table),{method,body:JSON.stringify({values,key,version:row?.__version,confirm:true})});
        offset=method==='DELETE'?0:offset;
        await load();
      } catch(e) {status.textContent=e.message;host.querySelectorAll('button').forEach(b=>b.disabled=false);}
    }
    host.querySelector('#xcEditForm').onsubmit=e=>{e.preventDefault();void save(row?'PATCH':'POST');};
    host.querySelector('#xcDelete')?.addEventListener('click',()=>void save('DELETE'));
  }
  window.XCollector = Object.freeze({render});
  document.querySelector('#navigation').addEventListener('click',e=>{if(e.target.closest('button')!==nav){active=false;++generation;}});
  document.querySelector('#logoutButton').addEventListener('click',()=>{active=false;++generation;},true);
  document.querySelector('#refreshButton').addEventListener('click',e=>{if(active){e.stopImmediatePropagation();void render();}},true);
})();
