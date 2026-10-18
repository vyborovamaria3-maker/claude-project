// Resolve the local collector against the current admin host, never a third-party host.
(() => {
  const link = document.getElementById("tgCollectorNav");
  if (!link) return;
  const host = location.hostname;
  if (["127.0.0.1", "localhost", "[::1]"].includes(host)) {
    const url = new URL(location.origin);
    url.port = "3100";
    url.pathname = "/admin/tg-collector";
    link.href = url.href;
  } else {
    // Deployed frontends expose the collector through their own origin.
    link.href = "/admin/tg-collector";
  }
  link.style.textDecoration = "none";
})();
