"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { authHeaders } from "@/lib/clientAuth";
import type { ManagedTargetKind, ManagedTargetState, ManagedTargetDecision } from "@/lib/trade/hood-hunt-strategy";

type Preset = "copy" | "Strict" | "Upside" | "Fast start" | "After bundle" | "Dev sell";
type Target = {
  kind: ManagedTargetKind;
  address: string;
  setup: Preset;
  state: ManagedTargetState;
  favorite: boolean;
  note: string | null;
  latestVerdict: string | null;
  pnl7dSol: number | null;
  consecutiveLiveLosses: number | null;
  lastReviewedAt: number | null;
  decision: ManagedTargetDecision;
};
const DEV_SETUPS: Preset[] = ["Strict", "Upside", "Fast start", "After bundle", "Dev sell"];
const short = (address: string) => address.slice(0, 7) + "…" + address.slice(-5);

export default function HoodHuntStrategyPage() {
  const [items, setItems] = useState<Target[]>([]);
  const [kind, setKind] = useState<ManagedTargetKind>("wallet");
  const [setup, setSetup] = useState<Preset>("copy");
  const [address, setAddress] = useState("");
  const [note, setNote] = useState("");
  const [favorite, setFavorite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/trade/hood-hunt/targets", { headers: authHeaders(), cache: "no-store" });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "Не удалось получить список целей");
    setItems(body.items || []);
  }, []);

  useEffect(() => {
    refresh().catch((reason) => setError(String(reason)));
  }, [refresh]);

  const update = async (payload: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/trade/hood-hunt/targets", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(payload),
      });
      const response = await res.json();
      if (!res.ok) throw new Error(response.error || "Не удалось сохранить цель");
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const add = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void update({ kind, setup, address: address.trim(), note: note.trim(), favorite, state: "watch" });
  };

  return (
    <main className="w-full max-w-[1200px] mx-auto space-y-5 px-4 py-5">
      <header>
        <h1 className="text-2xl font-bold text-white">Hood Hunt · управление целями</h1>
        <p className="mt-2 max-w-3xl text-xs text-white/55">
          Локальный список наблюдения и журнал пересмотра. Статус paused не останавливает
          внешнего торгового бота Blizz: его исполнение необходимо контролировать отдельно.
          PnL и серия убытков в этом списке вводятся вручную, пока не подключён журнал реальных ордеров.
        </p>
      </header>

      <form onSubmit={add} className="surface-panel rounded-xl p-4 space-y-3">
        <h2 className="text-sm font-semibold text-white">Добавить цель</h2>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
          <select value={kind} onChange={(e) => {
            const next = e.target.value as ManagedTargetKind;
            setKind(next); setSetup(next === "wallet" ? "copy" : "Strict");
          }} className="rounded-md border border-bg-border bg-bg px-3 py-2 text-xs text-white">
            <option value="wallet">Кошелёк</option>
            <option value="dev">Дев</option>
          </select>
          <select value={setup} onChange={(e) => setSetup(e.target.value as Preset)}
            className="rounded-md border border-bg-border bg-bg px-3 py-2 text-xs text-white">
            {(kind === "wallet" ? ["copy"] : DEV_SETUPS).map((option) =>
              <option key={option} value={option}>{option}</option>)}
          </select>
          <input value={address} onChange={(e) => setAddress(e.target.value)}
            placeholder="Solana address" required minLength={32} maxLength={44}
            className="rounded-md border border-bg-border bg-bg px-3 py-2 text-xs text-white" />
          <input value={note} onChange={(e) => setNote(e.target.value)}
            maxLength={500} placeholder="Примечание"
            className="rounded-md border border-bg-border bg-bg px-3 py-2 text-xs text-white" />
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-white/75">
            <input type="checkbox" checked={favorite} onChange={(e) => setFavorite(e.target.checked)} /> Избранное
          </label>
          <button type="submit" disabled={busy}
            className="rounded-md border border-sky-400/30 bg-sky-400/10 px-4 py-2 text-xs font-semibold text-sky-200 disabled:opacity-50">
            Сохранить
          </button>
        </div>
      </form>

      {error && <div role="alert" className="rounded-md border border-red-400/30 p-3 text-xs text-red-300">{error}</div>}

      <section className="surface-panel p-4 rounded-xl space-y-3">
        <div className="flex justify-between gap-3">
          <h2 className="text-sm font-semibold text-white">Цели ({items.length})</h2>
          <button type="button" disabled={busy} onClick={() => void refresh().catch((reason) => setError(String(reason)))}
            className="text-xs text-sky-300">Обновить</button>
        </div>
        {items.length === 0 && <p className="text-xs text-white/45">Нет целей или доступ ограничен.</p>}
        <div className="space-y-2">
          {items.map((item) => (
            <div key={[item.kind, item.address, item.setup].join(":")}
              className="rounded-lg border border-bg-border px-3 py-3 space-y-2">
              <div className="flex flex-wrap justify-between items-center gap-2">
                <div className="text-xs text-white">
                  <span className="font-semibold">{item.favorite ? "★ " : ""}{item.kind} / {item.setup}</span>
                  {" · "}<span className="font-mono" title={item.address}>{short(item.address)}</span>
                  {" · "}<span className="text-sky-200">{item.state}</span>
                </div>
                <div className="text-[11px] text-white/60">
                  7д PnL: {item.pnl7dSol === null ? "—" : item.pnl7dSol.toFixed(3) + " SOL"}
                  {" · "}убытков подряд: {item.consecutiveLiveLosses ?? "—"}
                  {" · "}пересмотр: {item.decision.requiresReview ? "нужен" : "не требуется"}
                </div>
              </div>
              <p className="text-[11px] text-white/45">{item.note || "Без примечания"}</p>
              {item.decision.reasons.length > 0 &&
                <p className="text-[11px] text-yellow-300/75">{item.decision.reasons.join(" ")}</p>}
              <div className="flex flex-wrap gap-2 text-xs">
                <button disabled={busy} type="button" onClick={() => void update({
                  kind: item.kind, address: item.address, setup: item.setup, reviewed: true,
                })} className="rounded border border-bg-border px-2 py-1 text-white/80">Пересмотрено</button>
                <button disabled={busy} type="button" onClick={() => void update({
                  kind: item.kind, address: item.address, setup: item.setup, favorite: !item.favorite,
                })} className="rounded border border-bg-border px-2 py-1 text-white/80">
                  {item.favorite ? "Убрать ★" : "В избранное ★"}
                </button>
                <button disabled={busy} type="button" onClick={() => void update({
                  kind: item.kind, address: item.address, setup: item.setup,
                  state: item.state === "active" ? "paused" : "active",
                })} className="rounded border border-bg-border px-2 py-1 text-white/80">
                  {item.state === "active" ? "Пауза" : "Активировать"}
                </button>
                <button disabled={busy} type="button" onClick={() => void update({
                  kind: item.kind, address: item.address, setup: item.setup, state: "removed",
                })} className="rounded border border-red-500/30 px-2 py-1 text-red-300">Снять цель</button>
              </div>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
