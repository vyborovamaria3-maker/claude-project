import type { ReactNode } from "react";
import {
  AlertTriangle,
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
  CircleDollarSign,
  Clock3,
  ShieldAlert,
} from "lucide-react";
import type { EntryPriceState, EntryThesis } from "@/lib/trade/entry-thesis";

function priceStateLabel(state: EntryPriceState) {
  if (state === "discounted_vs_signal") return "Цена ниже силы сигнала";
  if (state === "reasonable_vs_signal") return "Цена выглядит нормальной";
  if (state === "stretched_vs_signal") return "Цена растянута";
  if (state === "overheated_vs_signal") return "Цена перегрета";
  if (state === "unstable_vs_signal") return "Цена нестабильна";
  return "Цена не оценена";
}

function actionClass(action: EntryThesis["action"]) {
  if (action === "strong_entry") return "border-success/35 bg-success/10 text-success";
  if (action === "consider") return "border-primary/35 bg-primary/10 text-primary";
  if (action === "wait_confirmation") return "border-warning/35 bg-warning/10 text-warning";
  return "border-danger/35 bg-danger/10 text-danger";
}

function priceClass(state: EntryPriceState) {
  if (state === "discounted_vs_signal") return "text-success";
  if (state === "reasonable_vs_signal") return "text-primary";
  if (state === "stretched_vs_signal") return "text-warning";
  if (state === "overheated_vs_signal") return "text-danger";
  if (state === "unstable_vs_signal") return "text-danger";
  return "text-content-muted";
}

function ListBlock({ title, rows, icon, className = "" }: { title: string; rows: string[]; icon: ReactNode; className?: string }) {
  if (!rows.length) return null;
  return (
    <div className={`rounded-xl border border-bg-border bg-bg-card p-3.5 ${className}`}>
      <div className="flex items-center gap-2 text-[9px] font-semibold uppercase tracking-wider text-content-faint">{icon}{title}</div>
      <div className="mt-2 space-y-2">
        {rows.map((row) => (
          <div key={row} className="flex gap-2 text-[10px] leading-4 text-content-muted">
            <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-current" />
            <span>{row}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TechnicalMetric({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-lg border border-bg-border bg-bg-card p-3">
      <div className="text-[8px] uppercase tracking-wider text-content-faint">{label}</div>
      <div className="mt-1 font-mono text-sm font-bold text-content">{value}</div>
      <div className="mt-1 text-[8px] leading-4 text-content-faint">{note}</div>
    </div>
  );
}

export default function EntryThesisCard({ thesis }: { thesis: EntryThesis }) {
  return (
    <article className="surface-panel overflow-hidden rounded-2xl border border-bg-border">
      <div className="p-4">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="max-w-4xl">
            <div className="flex items-center gap-2">
              <CircleDollarSign className="h-4 w-4 text-primary" />
              <div className="text-[9px] font-semibold uppercase tracking-[0.15em] text-content-faint">Цена и момент входа</div>
            </div>
            <h2 className="mt-2 text-base font-semibold leading-6 text-content">{thesis.headline}</h2>
            <p className="mt-2 text-[12px] leading-5 text-content-muted">{thesis.thesis}</p>
          </div>

          <div className={`shrink-0 rounded-xl border px-4 py-3 ${actionClass(thesis.action)}`}>
            <div className="text-[8px] uppercase tracking-wider opacity-70">Вывод системы</div>
            <div className="mt-1 text-sm font-bold">{thesis.actionLabel}</div>
            <div className="mt-1 font-mono text-[10px] opacity-80">уверенность {Math.round(thesis.confidence)}%</div>
          </div>
        </div>

        <div className="mt-4 rounded-xl border border-primary/20 bg-primary/5 p-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-[9px] font-semibold uppercase tracking-wider text-content-faint">По текущей цене</div>
            <div className={`text-[11px] font-semibold ${priceClass(thesis.priceState)}`}>{priceStateLabel(thesis.priceState)}</div>
          </div>
          <p className="mt-2 text-[12px] leading-5 text-content">{thesis.priceExplanation}</p>
        </div>

        {thesis.qwenView && (
          <div className="mt-3 rounded-xl border border-neon-purple/25 bg-neon-purple/5 p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-[9px] font-semibold uppercase tracking-wider text-neon-purple">
                <BrainCircuit className="h-3.5 w-3.5" />
                Анализ Qwen
              </div>
              <span className="text-[8px] text-content-faint">
                {thesis.qwenAgreement === "agree" ? "совпадает с моделью" : thesis.qwenAgreement === "partial" ? "частично совпадает" : thesis.qwenAgreement === "disagree" ? "есть расхождение" : "дополнительная интерпретация"}
              </span>
            </div>
            <p className="mt-2 text-[11px] leading-5 text-content-muted">{thesis.qwenView}</p>
          </div>
        )}

        <div className="mt-3 grid gap-3 xl:grid-cols-2">
          <ListBlock title="Почему вход рассматривается сейчас" rows={thesis.whyNow} icon={<CheckCircle2 className="h-3.5 w-3.5 text-success" />} />
          <ListBlock title="Что уже могло быть заложено в цену" rows={thesis.alreadyPricedIn} icon={<Clock3 className="h-3.5 w-3.5 text-warning" />} />
        </div>

        <div className="mt-3 grid gap-3 xl:grid-cols-2">
          <ListBlock title="Чего ещё не хватает" rows={thesis.confirmationNeeded} icon={<AlertTriangle className="h-3.5 w-3.5 text-warning" />} />
          <ListBlock title="Что сломает входной тезис" rows={thesis.invalidation} icon={<ShieldAlert className="h-3.5 w-3.5 text-danger" />} />
        </div>

        <p className="mt-3 text-[9px] leading-4 text-content-faint">Оценка сравнивает текущую цену с доступным social/on-chain/market сигналом и не является оценкой фундаментальной стоимости или персональной рекомендацией.</p>
      </div>

      <details data-collapse="entry-thesis-technical" data-default-open="false" className="group border-t border-bg-border">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-[10px] font-semibold text-content-muted hover:bg-bg-elevated/50">
          <span>Показать техническую основу решения</span>
          <span className="flex items-center gap-2 font-mono text-[9px] font-normal text-content-faint">
            entry {Math.round(thesis.deterministicEntryScore)} · support {Math.round(thesis.evidenceSupportScore)} · heat {Math.round(thesis.overextensionScore)}
            <ChevronDown className="h-4 w-4 transition-transform duration-200 group-open:rotate-180" />
          </span>
        </summary>
        <div data-tag="entry-thesis-technical-body" className="grid gap-2 border-t border-bg-border p-4 sm:grid-cols-2 xl:grid-cols-4">
          <TechnicalMetric label="Entry score" value={`${Math.round(thesis.deterministicEntryScore)}/100`} note="Детерминированный timing после risk/heat поправок." />
          <TechnicalMetric label="Evidence support" value={`${Math.round(thesis.evidenceSupportScore)}/100`} note="Поддержка от доступных social/on-chain источников." />
          <TechnicalMetric label="Overextension" value={`${Math.round(thesis.overextensionScore)}/100`} note="Насколько движение уже растянуто по пригодным price evidence." />
          <TechnicalMetric label="Qwen agreement" value={thesis.qwenAgreement === "unavailable" ? "—" : thesis.qwenAgreement} note="Расхождение AI не скрывается и снижает итоговую уверенность." />
        </div>
      </details>
    </article>
  );
}
