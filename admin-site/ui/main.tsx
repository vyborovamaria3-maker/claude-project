import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "../../solana-launcher/lib/react-query";
import XCollectorTab from "../../solana-launcher/app/settings/XCollectorTab";
import TGCollectorTab from "../../solana-launcher/app/settings/TGCollectorTab";
import TGInviteWorkspace from "../../solana-launcher/components/tginvite/TGInviteWorkspace";
import "../../solana-launcher/app/globals.css";
import "../../solana-launcher/app/adaptive-theme.css";
import "./style.css";

const client = new QueryClient();
const modules = [ ["x-collector", "X Collector"], ["tg-collector", "TG Collector"], ["tg-invite", "TG Invite"] ];
function App() {
  const [access, setAccess] = useState("loading");
  useEffect(() => {
    const abort = new AbortController();
    fetch("/api/me", { cache: "no-store", signal: abort.signal })
      .then(response => setAccess(response.ok ? "ready" : "denied"))
      .catch(() => { if (!abort.signal.aborted) setAccess("denied"); });
    return () => abort.abort();
  }, []);
  const active = location.pathname.split("/").filter(Boolean)[1];
  return <main className="collector-console">
    <header><a href="/">← Control Center</a><h1>Управление сборщиками</h1></header>
    <nav aria-label="Collector administration">{modules.map(([id, label]) => <a key={id} href={`/collectors/${id}`} aria-current={active === id ? "page" : undefined}>{label}</a>)}</nav>
    {access === "loading" ? <p role="status">Проверка доступа…</p> : access === "denied" ? <p role="alert">Требуется вход администратора. <a href="/">Открыть вход в Control Center</a></p> :
      <QueryClientProvider client={client}>{active === "x-collector" ? <XCollectorTab/> : active === "tg-collector" ? <TGCollectorTab/> : active === "tg-invite" ? <TGInviteWorkspace/> : <p>Выберите инструмент.</p>}</QueryClientProvider>}
  </main>;
}
createRoot(document.getElementById("root")!).render(<App/>);
