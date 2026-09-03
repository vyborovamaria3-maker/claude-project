import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, Sparkles } from "lucide-react";
import type { NarrativeTone, SourceNarrative } from "@/lib/trade/source-narrative";

type Props = {
  title: string;
  icon: ReactNode;
  narrative: SourceNarrative;
  collapseKey: string;
  children?: ReactNode;
};

function toneLabel(tone: NarrativeTone) {
  if (tone === "positive") return "скорее позитивно";
  if (tone === "negative") return "скорее негативно";
  if (tone === "mixed") return "смешанная картина";
  return "данных недостаточно";
}

function toneClass(tone: NarrativeTone) {
  if (tone === "positive") return "text-success border-success/25 bg-success/5";
  if (tone === "negative") return "text-danger border-danger/25 bg-danger/5";
  if (tone === "mixed") return "text-warning border-warning/25 bg-warning/5";
  return "text-content-muted border-bg-border bg-bg-card";
}

function EvidenceList({
  title,
  rows,
  tone,
}: {
  title: string;
  rows: string[];
  tone: "positive" | "warning";
}) {
  if (!rows.length) return null;
  const Icon = tone === "positive" ? CheckCircle2 : AlertTriangle;
  return (
    <div className="rounded-xl border border-bg-border bg-bg-card p-3">
      <div className={`flex items-center gap-2 text-[9px] font-semibold uppercase tracking-wider ${tone === "positive" ? "text-success" : "text-warning"}`}>
        <Icon className="h-3.5 w-3.5" />
        {title}
      </div>
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

export default function SourceNarrativeCard({
  title,
  icon,
  narrative,
  collapseKey,
  children,
}: Props) {
  return (
    <article className="surface-panel overflow-hidden rounded-2xl border border-bg-border">
      <div className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <span className="mt-0.5 text-primary [&>svg]:h-4 [&>svg]:w-4">{icon}</span>
            <div>
              <h2 className="text-sm font-semibold text-content">{title}</h2>
              <div className="mt-0.5 text-[9px] text-content-faint">{narrative.headline}</div>
            </div>
          </div>

          <div className={`rounded-lg border px-2.5 py-1.5 text-right ${toneClass(narrative.tone)}`}>
            <div className="text-[8px] uppercase tracking-wider opacity-70">Оценка источника</div>
            <div className="mt-0.5 text-[10px] font-semibold">{toneLabel(narrative.tone)}</div>
          </div>
        </div>

        <div className="mt-4 rounded-xl border border-primary/20 bg-primary/5 p-3.5">
          <div className="flex items-center gap-2 text-[9px] font-semibold uppercase tracking-[0.14em] text-primary">
            <Sparkles className="h-3.5 w-3.5" />
            Что происходит сейчас
          </div>
          <p className="mt-2 text-[12px] leading-5 text-content">{narrative.currentSituation}</p>
        </div>

        <div className="mt-3 grid gap-3 xl:grid-cols-2">
          <div className="rounded-xl border border-bg-border bg-bg-card p-3.5">
            <div className="text-[9px] font-semibold uppercase tracking-wider text-content-faint">Как это понимать</div>
            <p className="mt-2 text-[11px] leading-5 text-content-muted">{narrative.interpretation}</p>
          </div>

          <div className="rounded-xl border border-bg-border bg-bg-card p-3.5">
            <div className="text-[9px] font-semibold uppercase tracking-wider text-content-faint">Что это значит для входа</div>
            <p className="mt-2 text-[11px] leading-5 text-content-muted">{narrative.entryMeaning}</p>
          </div>
        </div>

        {narrative.keyActors.length > 0 && (
          <div className="mt-3 rounded-xl border border-bg-border bg-bg-card p-3.5">
            <div className="text-[9px] font-semibold uppercase tracking-wider text-content-faint">Кто сейчас двигает ситуацию</div>
            <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
              {narrative.keyActors.map((actor) => (
                <div key={actor} className="rounded-lg border border-bg-border px-2.5 py-2 text-[9px] leading-4 text-content-muted">
                  {actor}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mt-3 grid gap-3 xl:grid-cols-2">
          <EvidenceList title="Что подтверждает движение" rows={narrative.positiveEvidence} tone="positive" />
          <EvidenceList title="Что настораживает" rows={narrative.warningEvidence} tone="warning" />
        </div>
      </div>

      <details
        data-collapse={`narrative-${collapseKey}`}
        data-default-open="false"
        className="group border-t border-bg-border"
      >
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-[10px] font-semibold text-content-muted hover:bg-bg-elevated/50">
          <span>Доказательства и технические параметры</span>
          <span className="flex items-center gap-2 text-[9px] font-normal text-content-faint">
            уверенность {Math.round(narrative.confidence)}%
            <ChevronDown className="h-4 w-4 transition-transform duration-200 group-open:rotate-180" />
          </span>
        </summary>

        <div className="border-t border-bg-border p-4">
          {narrative.parameters.length > 0 ? (
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {narrative.parameters.map((row) => (
                <div key={`${row.label}-${row.value}`} className="rounded-lg border border-bg-border bg-bg-card p-2.5">
                  <div className="text-[8px] uppercase tracking-wider text-content-faint">{row.label}</div>
                  <div className="mt-1 font-mono text-[11px] font-semibold text-content">{row.value}</div>
                  {row.note && <div className="mt-1 text-[8px] leading-3 text-content-faint">{row.note}</div>}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[10px] text-content-faint">Технические параметры этого источника пока недоступны.</div>
          )}

          {children && <div className="mt-4">{children}</div>}
        </div>
      </details>
    </article>
  );
}
