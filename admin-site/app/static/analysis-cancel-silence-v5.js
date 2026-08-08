(() => {
  function cleanupCancelledMutation() {
    window.setTimeout(() => {
      const status = document.querySelector("#analysisEditorStatus");
      if (status && status.textContent.includes("отменено пользователем")) {
        status.textContent = "";
        status.classList.remove("error");
      }
      const toast = document.querySelector("#toast");
      if (toast && toast.textContent.includes("отменено пользователем")) {
        toast.textContent = "";
        toast.className = "toast";
      }
    }, 0);
  }

  document.addEventListener("click", (event) => {
    const modal = document.querySelector("#analysisConfirmModal");
    if (!modal || modal.classList.contains("hidden")) return;
    if (event.target.closest?.("#analysisConfirmCancel") || event.target === modal) cleanupCancelledMutation();
  }, true);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") cleanupCancelledMutation();
  }, true);
})();
