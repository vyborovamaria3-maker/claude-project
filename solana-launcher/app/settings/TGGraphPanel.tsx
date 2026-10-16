"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, GitBranch, RefreshCw, ExternalLink } from "lucide-react";
import type { TgGraphEdge as Edge, TgGraphEvidence as Evidence, TgGraphResponse as GraphData } from "@/lib/tgCollectorTypes";

type SourceOption = { id: string; identifier: string };

const endpoint = "/api/integrations/tg-collector/graph";
const kindName: Record<Edge["kind"], string> = {
  forward: "Пересылка", mention: "Упоминание", address: "Адрес в тексте",
};
const edgeStyle: Record<Edge["kind"], { stroke: string; dash?: string }> = {
  forward: { stroke: "#34d399" },
  mention: { stroke: "#60a5fa" },
  address: { stroke: "#fbbf24", dash: "5 4" },
};

function prettyDate(value: string | null): string {
  return value ? new Date(value).toLocaleString("ru-RU") : "—";
}

export default function TGGraphPanel({ sources, authToken }: { sources: SourceOption[]; authToken: string }) {
  const [days, setDays] = useState(90);
  const [source, setSource] = useState("");
  const [onlyKind, setOnlyKind] = useState<"all" | Edge["kind"]>("all");
  const [data, setData] = useState<GraphData | null>(null);
  const [selection, setSelection] = useState<Edge | null>(null);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [loadingEvidence, setLoadingEvidence] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    const params = new URLSearchParams({ days: String(days) });
    if (source) params.set("source", source);
    setBusy(true);
    try {
      const response = await fetch(endpoint + "?" + params, { cache: "no-store", signal, headers: {Authorization: "Bearer " + authToken} });
      const body = await response.json() as GraphData & {error?: string};
      if (!response.ok) throw new Error(body.error || "Граф недоступен");
      if (!signal?.aborted) { setData(body); setError(null); }
    } catch (err) {
      if (!signal?.aborted) setError(err instanceof Error ? err.message : "Не удалось получить граф");
    } finally {
      if (!signal?.aborted) setBusy(false);
    }
  }, [source, days, authToken]);

  useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    const timer = setInterval(() => void load(ctrl.signal), 60_000);
    return () => { ctrl.abort(); clearInterval(timer); };
  }, [load]);

  useEffect(() => {
    setSelection(null);
    setEvidence([]);
  }, [source, days]);

  useEffect(() => {
    if (!selection) { setEvidence([]); return; }
    const ctrl = new AbortController();
    setEvidence([]);
    setLoadingEvidence(true);
    const params = new URLSearchParams({
      mode: "evidence", days: String(days),
      source: selection.sourceId, kind: selection.kind,
      targetKind: selection.targetKind, targetKey: selection.targetKey,
    });
    void (async () => {
      try {
        const response = await fetch(endpoint + "?" + params, { cache: "no-store", signal: ctrl.signal, headers: {Authorization: "Bearer " + authToken} });
        const payload = await response.json() as {evidence?: Evidence[]; error?: string};
        if (!response.ok) throw Error(payload.error || "Основания недоступны");
        if (!ctrl.signal.aborted) setEvidence(payload.evidence || []);
      } catch (err) {
        if (!ctrl.signal.aborted) setError(err instanceof Error ? err.message : "Ошибка загрузки оснований");
      } finally { if (!ctrl.signal.aborted) setLoadingEvidence(false); }
    })();
    return () => ctrl.abort();
  }, [selection, days, authToken]);

  const graph = useMemo(() => {
    const filtered = (data?.edges ?? []).filter(edge => onlyKind === "all" || onlyKind === edge.kind);
    const origins: string[] = [];
    const targets: string[] = [];
    const visible: Edge[] = [];
    for (const e of filtered) {
      if (!origins.includes(e.from) && origins.length >= 18) continue;
      if (!targets.includes(e.to) && targets.length >= 24) continue;
      if (visible.length >= 90) break;
      if (!origins.includes(e.from)) origins.push(e.from);
      if (!targets.includes(e.to)) targets.push(e.to);
      visible.push(e);
    }
    const height = Math.max(260, 78 + Math.max(origins.length, targets.length) * 42);
    const y0 = 48;
    const yp = (id: string, group: string[]) => y0 + group.indexOf(id) * 42;
    const byId = new Map((data?.nodes ?? []).map(n => [n.id, n]));
    return { visible, origins, targets, height, y0, yp, byId, clipped: filtered.length > visible.length };
  }, [data, onlyKind]);

  return (
    <section className="surface-panel space-y-5 p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="flex items-center gap-2 text-lg font-semibold text-content"><GitBranch className="h-5 w-5 text-primary" /> Граф связей Telegram</h3>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-content-muted">
            Каждое ребро основано на конкретных сообщениях: пересылка, упоминание @handle или адрес в тексте.
            Связи не доказывают владение, а общие адреса — сговор или координацию.
          </p>
        </div>
        <button onClick={() => void load()} type="button" disabled={busy}
          className="inline-flex items-center gap-2 rounded-xl border border-bg-border px-3 py-2 text-sm text-content-muted disabled:opacity-40">
          <RefreshCw className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} /> Обновить
        </button>
      </div>
      <div className="flex flex-wrap gap-3">
        <label className="text-xs text-content-muted">Период
          <select value={days} onChange={event=>setDays(Number(event.target.value))}
            className="ml-2 rounded-lg border border-bg-border bg-bg-soft px-2 py-2 text-content">
            <option value={7}>7 дней</option><option value={30}>30 дней</option>
            <option value={90}>90 дней</option><option value={365}>365 дней</option>
            <option value={0}>Всё время</option>
          </select>
        </label>
        <label className="text-xs text-content-muted">Источник
          <select value={source} onChange={event=>setSource(event.target.value)}
            className="ml-2 max-w-56 rounded-lg border border-bg-border bg-bg-soft px-2 py-2 text-content">
            <option value="">Все источники</option>
            {sources.map(s => <option key={s.id} value={s.id}>@{s.identifier}</option>)}
          </select>
        </label>
        <label className="text-xs text-content-muted">Тип
          <select value={onlyKind} onChange={event=>setOnlyKind(event.target.value as typeof onlyKind)}
            className="ml-2 rounded-lg border border-bg-border bg-bg-soft px-2 py-2 text-content">
            <option value="all">Все связи</option>
            <option value="forward">Пересылки</option>
            <option value="mention">Упоминания</option>
            <option value="address">Адреса</option>
          </select>
        </label>
      </div>

      {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
      {data && (
        <div className="flex flex-wrap gap-3 text-xs text-content-muted">
          <span>Узлов: {data.nodes.length}</span>
          <span>Типизированных рёбер: {data.edges.length}</span>
          {data.sampled && <span className="text-amber-300">Показана ограниченная выборка: до {data.nodeLimit} узлов / {data.edgeLimit} рёбер</span>}
          {data.truncated && <span className="text-amber-300">Граф обрезан сервером по установленным лимитам</span>}
          {graph.clipped && <span className="text-amber-300">Для читабельности отображается часть рёбер</span>}
        </div>
      )}
      {data && graph.visible.length === 0 && (
        <p className="rounded-xl border border-bg-border p-5 text-sm text-content-muted">
          Нет наблюдаемых связей. Добавьте каналы и соберите сообщения; для ранее сохранённой истории выполните <code>npm run analyze:backfill</code>.
        </p>
      )}

      {graph.visible.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-bg-border bg-bg-soft/50" aria-label="Граф источников и упомянутых сущностей">
          <svg viewBox={`0 0 1100 ${graph.height}`} width="100%" className="min-w-[800px]" role="img" aria-label="Источники слева, наблюдаемые адреса, пересылки и упоминания справа">
            <text x="24" y="22" fill="currentColor" opacity=".6" fontSize="14">Источники</text>
            <text x="870" y="22" fill="currentColor" opacity=".6" fontSize="14">Связанные сущности</text>
            {graph.visible.map(e => {
              const a = graph.yp(e.from, graph.origins), b = graph.yp(e.to, graph.targets);
              const style = edgeStyle[e.kind];
              return (
                <path key={e.id} d={`M 237 ${a} C 450 ${a}, 650 ${b}, 860 ${b}`}
                  stroke={style.stroke} strokeWidth={Math.min(7, 1 + Math.log2(e.strength + 1))}
                  strokeDasharray={style.dash} strokeOpacity={selection?.id===e.id ? 1 : 0.55}
                  fill="none" className="cursor-pointer"
                  onClick={() => setSelection(e)}>
                  <title>{`${kindName[e.kind]} — ${e.strength} сообщений. Нажмите для просмотра оснований.`}</title>
                </path>
              );
            })}
            {graph.origins.map(id => {
              const node = graph.byId.get(id);
              return (
                <g key={id}>
                  <rect x="20" y={graph.yp(id, graph.origins)-16} width="218" height="32" rx="8" fill="#134e4a" stroke="#2dd4bf" strokeOpacity=".6" />
                  <text x="30" y={graph.yp(id,graph.origins)+5} fontSize="13" fill="white">{(node?.label || id).slice(0,27)}</text>
                  <title>{node?.label}</title>
                </g>
              );
            })}
            {graph.targets.map(id => {
              const node = graph.byId.get(id);
              return (
                <g key={id}>
                  <rect x="860" y={graph.yp(id, graph.targets)-16} width="225" height="32" rx="8" fill={node?.kind === "source" ? "#134e4a" : node?.kind === "handle" ? "#1e3a8a" : "#44403c"} stroke="#94a3b8" strokeOpacity=".5" />
                  <text x="870" y={graph.yp(id, graph.targets)+5} fontSize="13" fill="white">{(node?.label || id).slice(0,26)}</text>
                  <title>{node?.label}</title>
                </g>
              );
            })}
          </svg>
        </div>
      )}

      <div className="flex flex-wrap gap-4 text-xs text-content-muted">
        {(["forward","mention","address"] as const).map(kind=>(
          <span key={kind} className="inline-flex items-center gap-2">
            <span className="inline-block h-1 w-6 rounded" style={{backgroundColor:edgeStyle[kind].stroke}} /> {kindName[kind]}
          </span>
        ))}
        <span>Толщина линии = число сообщений-оснований.</span>
      </div>
      {graph.visible.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-semibold text-content">Связи и подтверждающие сообщения</h4>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {graph.visible.slice(0,12).map(edge=>(
              <button key={edge.id} type="button" onClick={()=>setSelection(edge)}
                aria-pressed={selection?.id===edge.id}
                className="rounded-lg border border-bg-border bg-bg-soft p-3 text-left text-xs hover:border-primary-border">
                <span className="block truncate text-content">{graph.byId.get(edge.from)?.label} → {graph.byId.get(edge.to)?.label}</span>
                <span className="mt-1 block text-content-muted">{kindName[edge.kind]} · {edge.strength} сообщений</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {selection && (
        <div className="rounded-xl border border-primary-border bg-bg-soft p-4">
          <div className="flex flex-wrap justify-between gap-3">
            <div>
              <h4 className="text-sm font-semibold text-content">{kindName[selection.kind]} · {selection.strength} сообщений</h4>
              <p className="mt-1 break-all text-xs text-content-muted">
                {graph.byId.get(selection.from)?.label} → {graph.byId.get(selection.to)?.label || selection.targetKey}
              </p>
              <p className="mt-1 text-xs text-content-muted">Последнее наблюдение: {prettyDate(selection.lastSeen)}</p>
            </div>
            <a href={selection.sampleUrl} target="_blank" rel="noreferrer noopener"
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"><ExternalLink className="h-3.5 w-3.5" /> Пример сообщения</a>
          </div>
          <div className="mt-3 space-y-2">
            {loadingEvidence && <p className="text-xs text-content-muted">Загрузка оснований…</p>}
            {!loadingEvidence && evidence.length === 0 && <p className="text-xs text-content-muted">Основания не найдены в выбранном периоде.</p>}
            {evidence.map(item => (
              <a key={item.message_id} href={`https://t.me/${item.identifier}/${item.message_id}`}
                target="_blank" rel="noreferrer noopener"
                className="block rounded-lg border border-bg-border px-3 py-2 text-xs hover:border-primary-border">
                <span className="text-primary">@{item.identifier} · #{item.message_id}</span>
                <span className="ml-2 text-content-muted">{prettyDate(item.posted_at)}</span>
                <span className="mt-1 block break-words whitespace-pre-wrap text-content-muted">{item.text.slice(0,260) || "(без текста)"}</span>
              </a>
            ))}
          </div>
        </div>
      )}

      {data && (data.sharedAddresses.length > 0 || data.observedAddresses.length > 0) && (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-bg-border p-4">
            <h4 className="text-sm font-semibold text-content">Общие адреса в разных источниках</h4>
            <p className="mt-1 text-xs text-content-muted">Совпадения в собранных текстах за выбранный период. Не подтверждают совместное управление.</p>
            <div className="mt-3 space-y-2">
              {data.sharedAddresses.slice(0,12).map((item,i)=>(
                <div key={i} className="flex justify-between gap-3 rounded-lg border border-bg-border bg-bg-soft px-3 py-2 text-xs">
                  <span className="break-all text-content">@{item.left_channel} ↔ @{item.right_channel}</span>
                  <span className="shrink-0 text-content-muted">{item.shared_addresses} общих</span>
                </div>
              ))}
              {!data.sharedAddresses.length && <p className="text-xs text-content-muted">Пересечений не обнаружено.</p>}
            </div>
          </div>
          <div className="rounded-xl border border-bg-border p-4">
            <h4 className="text-sm font-semibold text-content">Первые наблюдения адресов</h4>
            <p className="mt-1 text-xs text-content-muted">Дата первого сообщения только в нашем наборе данных, не дата создания актива.</p>
            <div className="mt-3 space-y-2">
              {data.observedAddresses.slice(0,12).map(item=>(
                <div key={item.target_kind + ":" + item.target_key}
                  className="rounded-lg border border-bg-border bg-bg-soft px-3 py-2 text-xs">
                  <div className="flex justify-between gap-2">
                    <span className="text-content">{item.target_kind === "solana_address" ? "Solana" : "EVM"}</span>
                    <span className="text-content-muted">{item.observed_in_sources} источн. · {item.occurrences} упом.</span>
                  </div>
                  <div className="mt-1 break-all font-mono text-content-muted">{item.target_key}</div>
                  <div className="mt-1 text-content-muted">Впервые: {prettyDate(item.first_observed_at)}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {data && data.metrics.length > 0 && (
        <div>
          <h4 className="mb-3 flex items-center gap-2 text-sm font-semibold text-content"><Activity className="h-4 w-4" /> Активность каналов</h4>
          <div className="overflow-x-auto rounded-xl border border-bg-border">
            <table className="w-full min-w-[690px] text-left text-xs text-content-muted">
              <thead className="bg-bg-soft text-content"><tr>
                <th className="p-3">Источник</th><th className="p-3">7 дн.</th><th className="p-3">30 дн.</th>
                <th className="p-3">Упом. handles</th><th className="p-3">Адресов</th><th className="p-3">Пересылок</th>
                <th className="p-3">Сред. просмотры*</th>
              </tr></thead>
              <tbody>{data.metrics.slice(0,30).map(row=>(
                <tr key={row.source_id} className="border-t border-bg-border">
                  <td className="p-3 text-content">@{row.identifier}</td>
                  <td className="p-3">{row.posts_7d}</td><td className="p-3">{row.posts_30d}</td>
                  <td className="p-3">{row.mentioned_handles}</td>
                  <td className="p-3">{row.observed_addresses}</td><td className="p-3">{row.forward_events}</td>
                  <td className="p-3">{row.avg_views_snapshot ?? "—"}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-content-muted">
            * Просмотры — снимок счётчиков при сборе, не уникальная аудитория. Число адресов — текстовые совпадения формата, не верификация токена или кошелька. Показаны до 30 каналов.
          </p>
        </div>
      )}
    </section>
  );
}
