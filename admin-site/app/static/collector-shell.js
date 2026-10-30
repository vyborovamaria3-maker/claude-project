// Keep every operational workspace inside the existing authenticated admin shell.
(() => {
  const modules = new Map([
    ['x-collector', 'X Collector'], ['tg-collector', 'TG Collector'],
    ['tg-invite', 'TG Invite'], ['diagnostics', 'Diagnostics'],
    ['apify', 'Apify'], ['blockchain', 'Blockchain'],
  ]);
  const prefix = 'collector-';
  const tables = document.querySelector('#navigation [data-view="xCollector"]');
  if (tables) tables.textContent = 'X Collector — таблицы';
  const overview = document.querySelector('#navigation [data-view="tgCollector"]');
  if (overview) overview.textContent = 'TG Collector — обзор';
  const previousRender = renderCurrentView;
  renderCurrentView = async function () {
    const module = state.view.startsWith(prefix) ? state.view.slice(prefix.length) : '';
    if (!modules.has(module)) {
      if (location.hash.startsWith('#collector-')) history.replaceState(null, '', location.pathname + location.search);
      return previousRender();
    }
    history.replaceState(null, '', '#collector-' + module);
    document.getElementById('viewTitle').textContent = modules.get(module);
    document.querySelectorAll('#navigation .nav-item').forEach(item => {
      item.classList.toggle('active', item.dataset.view === state.view);
    });
    const frame = document.createElement('iframe');
    frame.title = modules.get(module);
    frame.dataset.collectorWorkspace = module;
    frame.src = '/collectors/' + module + '?embedded=1';
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-downloads');
    frame.style.cssText = 'width:100%;min-height:800px;height:calc(100vh - 140px);border:0;grid-column:1/-1;display:block';
    document.getElementById('content').replaceChildren(frame);
  };
  // Replace old workspace links with ordinary view buttons in this shell.
  document.querySelectorAll('#navigation a[href^="/collectors/"]').forEach(link => {
    const module = new URL(link.href).pathname.split('/')[2];
    if (!modules.has(module)) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'nav-item';
    button.dataset.view = prefix + module;
    button.textContent = modules.get(module);
    link.replaceWith(button);
  });
  const followHash = () => {
    const module = location.hash.slice(1).replace(/^collector-/, '');
    if (!modules.has(module)) return;
    state.view = prefix + module;
    if (state.me) void renderCurrentView();
  };
  window.addEventListener('hashchange', followHash);
  window.addEventListener('message', event => {
    const frame = document.querySelector('iframe[data-collector-workspace]');
    if (!frame || event.origin !== location.origin || event.source !== frame.contentWindow) return;
    if (event.data?.type !== 'collector-height' || !Number.isFinite(event.data.height)) return;
    frame.style.height = Math.min(50000, Math.max(800, Math.ceil(event.data.height))) + 'px';
  });
  followHash();
})();
