// Add user workspaces as nested tabs; retain every existing admin renderer.
(() => {
  const modules = new Map([
    ['x-collector', 'Пользовательский X Collector'], ['tg-invite', 'TG Inviting'],
    ['diagnostics', 'Diagnostics'],
    ['apify', 'Apify'], ['blockchain', 'Настройки Blockchain'],
  ]);
  let selected = null;
  let generation = 0;
  document.getElementById('navigation').addEventListener('click', event => {
    if (event.target.closest('[data-view]')?.dataset.view === 'xCollector') selected = null;
  }, true);
  const previousRender = renderCurrentView;
  const host = document.getElementById('content');
  // Discard only the extra sidebar entries introduced by the migration.
  document.querySelectorAll('#navigation a[href^="/collectors/"], #navigation [data-view^="collector-"]').forEach(item => item.remove());
  function tabs() {
    const bar = document.createElement('section');
    bar.className = 'section full';
    bar.dataset.collectorTabs = '';
    bar.style.gridColumn = '1/-1';
    const nav = document.createElement('nav');
    nav.setAttribute('aria-label', 'Вкладки коллекторов');
    nav.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px';
    for (const [id, label] of [['', 'Администрирование'], ...modules]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.dataset.collectorTab = id || 'system';
      button.className = (selected || '') === id ? 'primary' : 'secondary';
      button.setAttribute('aria-pressed', String((selected || '') === id));
      button.onclick = () => {
        selected = id || null;
        window.XCollector?.deactivate?.();
        state.view = 'xCollector';
        void renderCurrentView();
      };
      nav.append(button);
    }
    bar.append(nav);
    return bar;
  }
  function installTabs() {
    if (state.view !== 'xCollector') return;
    if (!host.querySelector('[data-collector-tabs]')) host.prepend(tabs());
  }
  renderCurrentView = async function () {
    const legacy = state.view.startsWith('collector-') ? state.view.slice(10) : '';
    if (modules.has(legacy)) { selected = legacy; state.view = 'xCollector'; }
    if (state.view !== 'xCollector') { ++generation; return previousRender(); }
    const ticket = ++generation;
    history.replaceState(null, '', '#collectors');
    if (!selected) {
      const pending = previousRender();
      installTabs();
      await pending;
      if (ticket === generation && state.view === 'xCollector') installTabs();
      return;
    }
    window.XCollector?.deactivate?.();
    document.querySelectorAll('#navigation .nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === 'xCollector'));
    document.getElementById('viewTitle').textContent = 'X Collector';
    const frame = document.createElement('iframe');
    frame.title = modules.get(selected);
    frame.dataset.collectorWorkspace = selected;
    frame.src = '/collectors/' + selected + '?embedded=1';
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-downloads');
    frame.style.cssText = 'width:100%;min-height:800px;height:calc(100vh - 230px);border:0;grid-column:1/-1;display:block';
    host.replaceChildren(tabs(), frame);
  };
  // Native table filtering/redrawing keeps its own event handlers and gains only the tab bar.
  new MutationObserver(installTabs).observe(host, { childList: true });
  window.addEventListener('message', event => {
    const frame = host.querySelector('iframe[data-collector-workspace]');
    if (!frame || event.origin !== location.origin || event.source !== frame.contentWindow) return;
    if (event.data?.type !== 'collector-height' || !Number.isFinite(event.data.height)) return;
    frame.style.height = Math.min(50000, Math.max(800, Math.ceil(event.data.height))) + 'px';
  });
  const followHash = () => {
    const module = location.hash.slice(1).replace(/^collector-/, '');
    if (modules.has(module)) selected = module;
    else if (location.hash !== '#collectors') return;
    state.view = 'xCollector';
    if (state.me) void renderCurrentView();
  };
  window.addEventListener('hashchange', followHash);
  followHash();
})();
