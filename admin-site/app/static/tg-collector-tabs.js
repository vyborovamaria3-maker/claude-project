// Native TG administration and user TG workspace are independent sidebar views.
(() => {
  const previousRender = renderCurrentView;
  renderCurrentView = async function () {
    if (state.view !== 'tgCollectorUser') {
      if (state.view === 'tgCollector' && document.querySelector('iframe[data-collector-workspace="tg-collector"]')) {
        const loading = document.createElement('p'); loading.setAttribute('role', 'status'); loading.textContent = 'Загрузка TG Collector…';
        document.getElementById('content').replaceChildren(loading);
      }
      return previousRender();
    }
    window.TGCollector?.deactivate?.();
    history.replaceState(null, '', '#user-tg-collector');
    document.getElementById('viewTitle').textContent = 'Пользовательский TG Collector';
    document.querySelectorAll('#navigation .nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === 'tgCollectorUser'));
    const frame = document.createElement('iframe');
    frame.title = 'Пользовательский TG Collector'; frame.dataset.collectorWorkspace = 'tg-collector';
    frame.src = '/collectors/tg-collector?embedded=1';
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-downloads');
    frame.style.cssText = 'width:100%;min-height:800px;border:0;grid-column:1/-1;display:block';
    document.getElementById('content').replaceChildren(frame);
  };
  function followHash() {
    if (['#user-tg-collector','#collector-tg-collector'].includes(location.hash)) state.view = 'tgCollectorUser';
    else if (location.hash === '#tg-collector') state.view = 'tgCollector';
    else return;
    if (state.me) void renderCurrentView();
  }
  window.addEventListener('hashchange', followHash); followHash();
})();
