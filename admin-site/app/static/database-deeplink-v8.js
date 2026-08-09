function selectDatabaseFromHash() {
  if (window.location.hash !== "#database") return;
  state.view = "database";
  if (state.me) renderCurrentView();
}

selectDatabaseFromHash();
window.addEventListener("hashchange", selectDatabaseFromHash);
