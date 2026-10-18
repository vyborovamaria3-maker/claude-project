// Native Control Center view; all requests use its authenticated server bridge.
(() => {
  let page = 0, source = '', query = '', timer, generation = 0, busy = false;
  const esc = escapeHtml;
  const active = () => state.view === 'tgCollector' && state.me && !appView.classList.contains('hidden');
  async function render() {
    clearTimeout(timer);
    const version = ++generation;
    const params = new URLSearchParams({page: String(page), q: query});
    if (source) params.set('source', source);
    try {
      const d = await api('/api/tg-collector?' + params);
      if (!active() || version !== generation) return;
      const metrics = d.runtimeMetrics || {}, stats = d.stats || {};
      content.innerHTML = `<section class="domain-card">
        <div class="section-head"><h3>TG Collector</h3><button id="tgControl" class="primary" ${busy ? 'disabled' : ''}>${d.collectionEnabled ? 'Остановить сбор' : 'Запустить сбор'}</button></div>
        <p role="status">Сбор: ${d.collectionEnabled ? 'включён' : 'остановлен'} · Worker: ${d.workerOnline ? 'на связи' : 'нет связи'} · Прокси: ${d.proxy?.enabled ? esc(d.proxy.type || 'подключён') : 'выключен'}</p>
        <p>Последний сигнал: ${esc(formatDate(d.heartbeatAt))}${d.pausedUntil ? ' · Пауза до ' + esc(formatDate(d.pausedUntil)) : ''}</p>
        <p id="tgStatus" role="status"></p></section>
        <div class="cards">${renderMetric('Сообщения', formatNumber(stats.messages))}${renderMetric('За сегодня', formatNumber(metrics.messages_per_day))}${renderMetric('Связи', formatNumber(metrics.links_total))}${renderMetric('В очереди', formatNumber(metrics.jobs_pending))}${renderMetric('В работе', formatNumber(stats.running))}${renderMetric('Ошибки', formatNumber(stats.failed))}</div>
        <section class="domain-card"><h3>Источники</h3><div class="table-wrap"><table><thead><tr><th>Канал</th><th>Состояние</th><th>Сообщения</th><th>Последний сбор</th></tr></thead><tbody>${(d.sources || []).map(s => `<tr><td>${esc(s.identifier)}</td><td>${s.enabled ? 'Включён' : 'Пауза'}</td><td>${esc(s.message_count)}</td><td>${esc(formatDate(s.last_success_at))}</td></tr>`).join('')}</tbody></table></div></section>
        <section class="domain-card"><h3>Реальные сообщения</h3><form id="tgSearch" class="lookup"><select id="tgSource" aria-label="Канал"><option value="">Все каналы</option>${(d.sources || []).map(s => `<option value="${esc(s.id)}" ${String(s.id) === source ? 'selected' : ''}>${esc(s.identifier)}</option>`).join('')}</select><input id="tgQuery" maxlength="120" aria-label="Поиск сообщений" placeholder="Поиск сообщений" value="${esc(query)}"><button class="primary">Найти</button></form>
        <div>${(d.messages || []).map(m => `<article class="domain-card"><p>${esc(m.identifier)} · ${esc(formatDate(m.posted_at))} · #${esc(m.message_id)}</p><div style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(m.text || '[Сообщение без текста]')}</div></article>`).join('') || '<p>Сообщений по этому фильтру нет.</p>'}</div>
        <div class="section-head"><button id="tgPrev" ${page === 0 ? 'disabled' : ''}>Назад</button><span>Страница ${page + 1}</span><button id="tgNext" ${(d.messages || []).length < 40 || page >= 100 ? 'disabled' : ''}>Далее</button></div></section>`;
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
