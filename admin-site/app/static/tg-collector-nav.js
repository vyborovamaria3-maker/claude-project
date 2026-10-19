// Native Control Center view; all requests use its authenticated server bridge.
(() => {
  let page = 0, source = '', query = '', timer, generation = 0, busy = false;
  const esc = escapeHtml;
  const active = () => state.view === 'tgCollector' && state.me && !appView.classList.contains('hidden');
  function discoveryPanel(data) {
    if (!data?.settings) return '<section class="domain-card"><h3>Автопоиск</h3><p>Настройки пока недоступны. Проверьте worker и миграции.</p></section>';
    const d = data.settings;
    const inputs = [
      ['externalPagesPerCycle','Внешних страниц за цикл','external_pages_per_cycle',1,3],
        ['externalMaxPagesPerDay','Внешних страниц за сутки','external_max_pages_per_day',1,48],
        ['intervalMinutes','Интервал, минут','interval_minutes',15,1440],
      ['resultsPerQuery','Результатов на запрос','results_per_query',1,50],
      ['queriesPerCycle','Запросов за проход','queries_per_cycle',1,10],
      ['maxQueriesPerDay','Запросов за сутки','max_queries_per_day',1,200],
      ['maxNewPerDay','Новых источников за сутки','max_new_per_day',1,100],
      ['maxSources','Максимум источников всего','max_sources',1,1000],
      ['pumpMinAthUsd','Минимальный ATH капитализации, USD','pump_min_ath_usd',1000,1000000000],
        ['pumpMaxTokens','Запросов Pump.fun за цикл','pump_max_tokens',1,10],
        ['autoKeywordsLimit','Автослов в подборке','auto_keywords_limit',1,30],
      ['twitterLookbackHours','Посты Twitter за часы','twitter_lookback_hours',1,168],
      ['twitterTweetLimit','Максимум постов для анализа','twitter_tweet_limit',100,5000],
      ['minKeywordPosts','Минимум разных постов на слово','min_keyword_posts',2,20],
      ['minKeywordAuthors','Минимум разных авторов','min_keyword_authors',1,10]
    ];
    return `<section class="domain-card"><h3>Автопоиск: крипта и мемкоины</h3>
      <p>Поиск публичных постов по тексту или источников по названию. Новые источники автоматически попадают в очередь сбора. Вступлений в группы и личных сообщений нет. Общий стоп останавливает и поиск.</p>
      <p>Сегодня: ${esc(data.today?.queries || 0)} запросов · ${esc(data.today?.added || 0)} новых источников. Найдено всего: ${esc(data.totals?.found || 0)}. Суточные лимиты обновляются в 03:00 МСК.</p>
      <p>Последний поиск: ${esc(formatDate(d.last_completed_at))} · Следующий: ${esc(formatDate(d.next_run_at))}${d.last_error_code ? ' · '+esc(d.last_error_code.includes('PREMIUM')?'Глобальный поиск текста требует Telegram Premium. Используется доступный Telegram-индекс и поиск в собираемой истории; охват ограничен.':d.last_error_code) : ''}</p>
      <div class="cards">${renderMetric('Источники с упоминаниями',formatNumber(data.mentionStats?.sources||0))}${renderMetric('Уникальные найденные упоминания',formatNumber(data.mentionStats?.mentions||0))}${renderMetric('Упоминания в подключённых источниках',formatNumber(data.mentionStats?.connected_mentions||0))}</div>
      <p>Это реально полученные уникальные публичные посты, а не все упоминания в Telegram. Результат ограничен квотой Telegram, страницами и вашими лимитами. Платный поиск Stars не включается.</p>
      <form id="tgDiscoveryForm" style="display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(180px,1fr))">
        <label style="grid-column:1/-1"><input id="tgDiscoveryEnabled" type="checkbox" ${d.enabled?'checked':''}> Включить автопоиск и подключение найденных источников</label>
        <label style="grid-column:1/-1"><input id="tgExternalEnabled" type="checkbox" ${d.external_search_enabled?'checked':''}> Расширять поиск без Premium: публичные страницы, ссылки из Twitter и найденных постов</label>
        <label style="grid-column:1/-1">Начальные публичные каналы / чаты — до 50, по одному на строку<textarea id="tgExternalSources" rows="3" style="display:block;width:100%">${esc((d.external_sources||[]).join('\n'))}</textarea></label>
        <p style="grid-column:1/-1">Внешними источниками подтверждено сообщений: ${esc(data.externalStats?.mentions||0)}, источников: ${esc(data.externalStats?.sources||0)}. Страниц сегодня: ${esc(data.externalStats?.pages_today||0)}. Последняя проверка: ${esc(formatDate(d.external_last_run_at))}. Ссылки и фрагменты поисковиков не считаются упоминаниями до проверки Telegram. ${esc(d.external_error_code||'')}</p>
        <details style="grid-column:1/-1"><summary>Источники внешнего поиска</summary>${(data.externalQueue||[]).map(c=>`<p>@${esc(c.username)} · ${esc(({verified:'Посты подтверждены',related_public_group_connected:'Связанный публичный чат подключён',no_matching_posts:'На проверенной странице нет совпадений',unavailable:'Недоступен',not_public_channel:'Не публичный канал или чат',checking:'Проверяется',pending:'В очереди'})[c.status]||c.status)}</p>`).join('')}</details>
        <label style="grid-column:1/-1"><input id="tgMessageSearchEnabled" type="checkbox" ${d.message_search_enabled?'checked':''}> Искать в тексте публичных сообщений; собирать полную доступную историю найденных каналов и публичных чатов обсуждений</label>
        <label style="grid-column:1/-1">Тикер, название и минт — по одному на строку (до 30)<textarea id="tgMessageTerms" rows="3" style="display:block;width:100%">${esc((d.message_terms||[]).join('\n'))}</textarea></label>
        <label style="grid-column:1/-1"><input id="tgPumpEnabled" type="checkbox" ${d.pump_enabled?'checked':''}> Искать минты и тикеры Pump.fun с подтверждённым ATH капитализации</label>
        <label style="grid-column:1/-1">Минты / тикеры Pump.fun (до 10, через запятую; пусто — брать из Twitter)<input id="tgPumpQueries" value="${esc((d.pump_queries||[]).join(', '))}" maxlength="500" style="display:block;width:100%"></label>
        <p style="grid-column:1/-1">Порог подтверждается исторической капитализацией. Резервный источник — CoinGecko: максимум за 90 дней подтверждает, что ATH был не ниже этой суммы; это не точный ATH за всё время. ${esc(d.pump_error_code||'')} ${(d.pump_results||[]).map(t=>esc(t.symbol+' · '+t.mint+' · '+(t.evidenceType==='historical_lower_bound'?'Исторический максимум (90 дней) $':'ATH $')+(t.historicalPeakUsd??t.athUsd)+' · '+t.provider+(t.peakAt?' · '+formatDate(t.peakAt):''))).join('; ')}</p>
        <label style="grid-column:1/-1"><input id="tgAutoKeywordsEnabled" type="checkbox" ${d.auto_keywords_enabled?'checked':''}> Самостоятельно подбирать слова из сохранённых Twitter-постов</label>
        <p style="grid-column:1/-1">Разбор локальный: тикеры, хештеги и криптотемы. Одинаковые тексты и повторения одного автора не раздувают рейтинг. Последний анализ: ${esc(formatDate(d.keyword_refreshed_at))}; просмотрено постов: ${esc(d.keyword_post_count || 0)}${d.keyword_error_code ? ' · '+esc(d.keyword_error_code) : ''}. Автослов: ${esc((d.generated_keywords || []).join(', ') || 'пока нет — используются резервные слова')}.</p>
        <label style="grid-column:1/-1">Дополнительные/резервные слова — по одному на строку (до 30, необязательно при автоподборе)<textarea id="tgDiscoveryKeywords" rows="5" maxlength="2000" style="display:block;width:100%">${esc(d.keywords.join('\n'))}</textarea></label>
        ${inputs.map(([id,label,key,min,max])=>`<label>${label}<input id="${id}" type="number" min="${min}" max="${max}" value="${esc(d[key])}" required style="display:block;width:100%"></label>`).join('')}
        <button id="tgDiscoverySave" class="primary" type="submit">Сохранить настройки поиска</button><p id="tgDiscoveryStatus" role="status"></p>
      </form>
      <h4>Найденные публичные упоминания</h4>
      ${(data.mentions||[]).map(m=>`<article class="domain-card"><p>@${esc(m.username)} · ${esc(formatDate(m.posted_at))} · <a href="https://t.me/${esc(m.username)}/${esc(m.message_id)}" target="_blank" rel="noopener noreferrer">Открыть пост</a> · ${esc((m.matched_terms||[]).join(', '))}${m.external_providers?.length?' · Подтверждено из внешнего поиска':''}</p><div style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(m.text)}</div></article>`).join('')||'<p>Поиск сообщений ещё не получил публичных результатов.</p>'}
      <h4>Найденные источники по названию или постам</h4><div class="table-wrap"><table><thead><tr><th>Источник</th><th>Ключевое слово</th><th>Состояние</th></tr></thead><tbody>
      ${(data.candidates || []).map(c=>`<tr><td>${esc(c.title)} (@${esc(c.username)})</td><td>${esc(c.keyword)}</td><td>${c.connected ? (c.enabled ? 'Подключён' : 'На паузе') : c.connected_at ? 'Удалён оператором' : 'Найден, не подключён'}</td></tr>`).join('') || '<tr><td colspan="3">Источники появятся после первого поиска.</td></tr>'}</tbody></table></div>
    </section>`;
  }
  async function render() {
    clearTimeout(timer);
    const version = ++generation;
    const params = new URLSearchParams({page: String(page), q: query});
    if (source) params.set('source', source);
    try {
      const [d, discovery] = await Promise.all([api('/api/tg-collector?' + params), api('/api/tg-collector/discovery').catch(() => null)]);
      if (!active() || version !== generation) return;
      const metrics = d.runtimeMetrics || {}, stats = d.stats || {};
      content.innerHTML = `<section class="domain-card">
        <div class="section-head"><h3>TG Collector</h3><button id="tgControl" class="primary" ${busy ? 'disabled' : ''}>${d.collectionEnabled ? 'Остановить сбор' : 'Запустить сбор'}</button></div>
        <p role="status">Сбор: ${d.collectionEnabled ? 'включён' : 'остановлен'} · Worker: ${d.workerOnline ? 'на связи' : 'нет связи'} · Прокси: ${d.proxy?.enabled ? esc(d.proxy.type || 'подключён') : 'выключен'}</p>
        <p>Последний сигнал: ${esc(formatDate(d.heartbeatAt))}${d.pausedUntil ? ' · Пауза до ' + esc(formatDate(d.pausedUntil)) : ''}</p>
        <p id="tgStatus" role="status"></p></section>
        <div class="cards">${renderMetric('Сообщения', formatNumber(stats.messages))}${renderMetric('За сегодня', formatNumber(metrics.messages_per_day))}${renderMetric('Связи', formatNumber(metrics.links_total))}${renderMetric('В очереди', formatNumber(metrics.jobs_pending))}${renderMetric('В работе', formatNumber(stats.running))}${renderMetric('Ошибки', formatNumber(stats.failed))}</div>
        ${discoveryPanel(discovery)}
        <section class="domain-card"><h3>Источники</h3><div class="table-wrap"><table><thead><tr><th>Канал</th><th>Состояние</th><th>Сообщения</th><th>Последний сбор</th></tr></thead><tbody>${(d.sources || []).map(s => `<tr><td>${esc(s.identifier)}${s.discussion_for?'<br>Чат обсуждений @'+esc(s.discussion_for):s.discussion_status==='private_or_unavailable'?'<br>Чат обсуждений закрыт или недоступен':s.discussion_status==='source_limit'?'<br>Чат ожидает лимита источников':''}</td><td>${s.enabled ? 'Включён' : 'Пауза'}</td><td>${esc(s.message_count)}${s.full_history ? (s.history_complete ? ' · История собрана' : ' · Сбор всей истории') : ''}</td><td>${esc(formatDate(s.last_success_at))}</td></tr>`).join('')}</tbody></table></div></section>
        <section class="domain-card"><h3>Реальные сообщения</h3><form id="tgSearch" class="lookup"><select id="tgSource" aria-label="Канал"><option value="">Все каналы</option>${(d.sources || []).map(s => `<option value="${esc(s.id)}" ${String(s.id) === source ? 'selected' : ''}>${esc(s.identifier)}</option>`).join('')}</select><input id="tgQuery" maxlength="120" aria-label="Поиск сообщений" placeholder="Поиск сообщений" value="${esc(query)}"><button class="primary">Найти</button></form>
        <div>${(d.messages || []).map(m => `<article class="domain-card"><p>${esc(m.identifier)} · ${esc(formatDate(m.posted_at))} · #${esc(m.message_id)}</p><p>Просмотры: ${esc(m.views??'—')} · Реакции: ${esc(m.engagement_observed_at?((m.reactions||[]).map(r=>(r.emoji||'custom')+' '+r.count).join(', ')||'0'):'ещё не обновлены')} · Ответы: ${esc(m.replies??0)}</p><div style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(m.text || '[Сообщение без текста]')}</div></article>`).join('') || '<p>Сообщений по этому фильтру нет.</p>'}</div>
        <div class="section-head"><button id="tgPrev" ${page === 0 ? 'disabled' : ''}>Назад</button><span>Страница ${page + 1}</span><button id="tgNext" ${(d.messages || []).length < 40 || page >= 100 ? 'disabled' : ''}>Далее</button></div></section>`;
      const discoveryForm = document.getElementById('tgDiscoveryForm');
      if (discoveryForm) discoveryForm.onsubmit = async e => {
        e.preventDefault(); clearTimeout(timer); busy = true;
        const button = document.getElementById('tgDiscoverySave'); button.disabled = true;
        const body = {externalSearchEnabled:document.getElementById('tgExternalEnabled').checked,externalSources:document.getElementById('tgExternalSources').value.split(/\r?\n/).map(v=>v.trim().replace(/^@/,'')).filter(Boolean),messageSearchEnabled:document.getElementById('tgMessageSearchEnabled').checked,messageTerms:document.getElementById('tgMessageTerms').value.split(/\r?\n/).map(v=>v.trim()).filter(Boolean),pumpEnabled:document.getElementById('tgPumpEnabled').checked,pumpQueries:document.getElementById('tgPumpQueries').value.split(',').map(v=>v.trim().replace(/^\$/,'')).filter(Boolean),enabled: document.getElementById('tgDiscoveryEnabled').checked, autoKeywordsEnabled: document.getElementById('tgAutoKeywordsEnabled').checked,
          keywords: document.getElementById('tgDiscoveryKeywords').value.split(/\r?\n/).map(k=>k.trim()).filter(Boolean)};
        for (const key of ['externalPagesPerCycle','externalMaxPagesPerDay','pumpMinAthUsd','pumpMaxTokens','intervalMinutes','resultsPerQuery','queriesPerCycle','maxQueriesPerDay','maxNewPerDay','maxSources','autoKeywordsLimit','twitterLookbackHours','twitterTweetLimit','minKeywordPosts','minKeywordAuthors']) body[key] = Number(document.getElementById(key).value);
        try { await api('/api/tg-collector/discovery', {method:'POST',body:JSON.stringify(body)}); busy = false; if (active()) void render(); }
        catch (error) { busy = false; button.disabled = false; if(active()) document.getElementById('tgDiscoveryStatus').textContent = error.message; }
      };
      document.getElementById('tgSearch').onsubmit = e => {
        e.preventDefault(); source = document.getElementById('tgSource').value;
        query = document.getElementById('tgQuery').value.trim(); page = 0; void render();
      };
      document.getElementById('tgPrev').onclick = () => {page--; void render();};
      document.getElementById('tgNext').onclick = () => {page++; void render();};
      document.getElementById('tgControl').onclick = async () => {
        busy = true; clearTimeout(timer);
        const button = document.getElementById('tgControl'); button.disabled = true;
        try {
          await api('/api/tg-collector', {method: 'POST', body: JSON.stringify({action: d.collectionEnabled ? 'stop' : 'start'})});
        } catch (e) {
          if (active()) document.getElementById('tgStatus').textContent = e.message;
          busy = false; button.disabled = false; return;
        }
        busy = false; if (active()) void render();
      };
      // Do not replace a search being typed or steal focus during an automatic update.
      const schedule = () => { timer = setTimeout(() => {
        if (active() && !busy) {
          const focused = document.activeElement;
          if (focused && content.contains(focused)) { schedule(); return; }
          void render();
        }
      }, 15000); }; schedule();
    } catch (e) {
      if (active() && version === generation) content.innerHTML = `<section class="domain-card" role="alert">${esc(e.message)}<p>Нажмите «Обновить», чтобы повторить.</p></section>`;
    }
  }
  document.getElementById('navigation').addEventListener('click', e => {if (e.target.closest('[data-view]')?.dataset.view !== 'tgCollector') {clearTimeout(timer); ++generation;}});
  document.getElementById('logoutButton').addEventListener('click', () => {clearTimeout(timer); ++generation;}, true);
  window.TGCollector = Object.freeze({render});
})();
