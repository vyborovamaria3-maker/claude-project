import { AlertTriangle, CheckCircle2, ChevronDown, Network, SearchCheck } from "lucide-react";
import type { CrossSourceThesis } from "@/lib/trade/cross-source-thesis";

function stateClass(state: CrossSourceThesis["state"]) {
  if (state === "confirmed") return "border-success/30 bg-success/5 text-success";
  if (state === "risk_dominates" || state === "divergence") return "border-warning/30 bg-warning/5 text-warning";
  if (state === "insufficient") return "border-bg-border bg-bg-card text-content-muted";
  return "border-primary/30 bg-primary/5 text-primary";
}

function Evidence({
  title,
  rows,
  warning = false,
}: {
  title: string;
  rows: string[];
  warning?: boolean;
}) {
  if (!rows.length) return null;
  const Icon = warning ? AlertTriangle : CheckCircle2;
  return (
    <div className="rounded-xl border border-bg-border bg-bg-card p-3.5">
      <div className={`flex items-center gap-2 text-[9px] font-semibold uppercase tracking-wider ${warning ? "text-warning" : "text-success"}`}>
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

function value(value: number | null, suffix = "/100") {
  return value == null ? "—" : `${Math.round(value)}${suffix}`;
}

function timeLabel(timestamp: number | null) {
  if (timestamp == null) return "нет timestamp";
  return new Date(timestamp).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

export default function CrossSourceThesisCard({ thesis }: { thesis: CrossSourceThesis }) {
  return (
    <article className="surface-panel overflow-hidden rounded-2xl border border-bg-border">
      <div className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Network className="h-4 w-4 text-primary" />
              <div className="text-[9px] font-semibold uppercase tracking-[0.15em] text-content-faint">
                Как источники связаны между собой
              </div>
            </div>
            <h2 className="mt-2 max-w-4xl text-sm font-semibold leading-6 text-content">
              {thesis.headline}
            </h2>
          </div>
          <div className={`rounded-lg border px-3 py-2 font-mono text-[10px] font-semibold ${stateClass(thesis.state)}`}>
            confidence {Math.round(thesis.confidence)}%
          </div>
        </div>

        <div className="mt-4 rounded-xl border border-primary/20 bg-primary/5 p-3.5">
          <div className="text-[9px] font-semibold uppercase tracking-wider text-primary">
            Что происходит сейчас
          </div>
          <p className="mt-2 text-[12px] leading-5 text-content">{thesis.currentSituation}</p>
        </div>

        <div className="mt-3 grid gap-3 xl:grid-cols-4">
          <div className="rounded-xl border border-bg-border bg-bg-card p-3.5">
            <div className="text-[9px] font-semibold uppercase tracking-wider text-content-faint">Source independence</div>
            <div className="mt-2 font-mono text-lg font-semibold text-content">{value(thesis.independence.score)}</div>
            <div className="mt-1 text-[10px] leading-4 text-content-muted">
              независимых слоёв {thesis.independence.independentLayers}/{thesis.independence.availableLayers}
            </div>
          </div>
          <div className="rounded-xl border border-bg-border bg-bg-card p-3.5">
            <div className="text-[9px] font-semibold uppercase tracking-wider text-content-faint">Concentration risk</div>
            <div className="mt-2 font-mono text-lg font-semibold text-content">{value(thesis.independence.concentrationRisk)}</div>
            <div className="mt-1 text-[10px] leading-4 text-content-muted">{thesis.independence.verdict}</div>
          </div>
          <div className="rounded-xl border border-bg-border bg-bg-card p-3.5">
            <div className="text-[9px] font-semibold uppercase tracking-wider text-content-faint">Chronology coverage</div>
            <div className="mt-2 font-mono text-lg font-semibold text-content">{value(thesis.chronology.coverage, "%")}</div>
            <div className="mt-1 text-[10px] leading-4 text-content-muted">
              стадий {thesis.chronology.observedStages}/4
            </div>
          </div>
          <div className="rounded-xl border border-bg-border bg-bg-card p-3.5">
            <div className="text-[9px] font-semibold uppercase tracking-wider text-content-faint">Order alignment</div>
            <div className="mt-2 font-mono text-lg font-semibold text-content">{value(thesis.chronology.alignmentScore, "%")}</div>
            <div className="mt-1 text-[10px] leading-4 text-content-muted">
              smart wallet → TG → X → market
            </div>
          </div>
        </div>

        <div className="mt-3 grid gap-3 xl:grid-cols-3">
          {thesis.independence.layers.map((layer) => (
            <div key={layer.source} className="rounded-xl border border-bg-border bg-bg-card p-3.5">
              <div className="flex items-center justify-between gap-3">
                <div className="text-[9px] font-semibold uppercase tracking-wider text-content-faint">{layer.source}</div>
                <div className="font-mono text-[10px] text-content">{value(layer.independenceScore)}</div>
              </div>
              <div className="mt-1 text-[10px] text-content-muted">
                independent actors {layer.independentActors}/{layer.actors} · coverage {value(layer.coverageConfidence, "%")}
              </div>
              <p className="mt-2 text-[10px] leading-4 text-content-faint">{layer.note}</p>
            </div>
          ))}
        </div>

        <div className="mt-3 rounded-xl border border-bg-border bg-bg-card p-3.5">
          <div className="text-[9px] font-semibold uppercase tracking-wider text-content-faint">Cross-source chronology</div>
          <div className="mt-3 grid gap-2 lg:grid-cols-4">
            {thesis.chronology.stages.map((stage, index) => (
              <div key={stage.key} className="rounded-lg border border-bg-border bg-bg-elevated/30 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[9px] text-content-faint">{index + 1}</span>
                  <span className={`h-1.5 w-1.5 rounded-full ${stage.observed ? "bg-success" : "bg-content-faint"}`} />
                </div>
                <div className="mt-2 text-[10px] font-semibold text-content">{stage.label}</div>
                <div className="mt-1 font-mono text-[9px] text-content-muted">{timeLabel(stage.timestamp)}</div>
                <p className="mt-2 text-[9px] leading-4 text-content-faint">{stage.note}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-3 grid gap-3 xl:grid-cols-2">
          <div className="rounded-xl border border-bg-border bg-bg-card p-3.5">
            <div className="text-[9px] font-semibold uppercase tracking-wider text-content-faint">Последовательность</div>
            <p className="mt-2 text-[11px] leading-5 text-content-muted">{thesis.sequence}</p>
          </div>
          <div className="rounded-xl border border-bg-border bg-bg-card p-3.5">
            <div className="text-[9px] font-semibold uppercase tracking-wider text-content-faint">Что это значит для входа</div>
            <p className="mt-2 text-[11px] leading-5 text-content-muted">{thesis.entryMeaning}</p>
          </div>
        </div>

        <div className="mt-3 rounded-xl border border-bg-border bg-bg-card p-3.5">
          <div className="text-[9px] font-semibold uppercase tracking-wider text-content-faint">Интерпретация</div>
          <p className="mt-2 text-[11px] leading-5 text-content-muted">{thesis.interpretation}</p>
        </div>
      </div>

      <details data-collapse="cross-source-thesis" data-default-open="false" className="group border-t border-bg-border">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-[10px] font-semibold text-content-muted hover:bg-bg-elevated/50">
          <span className="flex items-center gap-2"><SearchCheck className="h-3.5 w-3.5" />Показать подтверждения и противоречия</span>
          <ChevronDown className="h-4 w-4 transition-transform duration-200 group-open:rotate-180" />
        </summary>
        <div className="grid gap-3 border-t border-bg-border p-4 xl:grid-cols-3">
          <Evidence title="Что совпадает" rows={thesis.agreements} />
          <Evidence title="Что противоречит" rows={thesis.contradictions} warning />
          <Evidence title="Какой факт нужен дальше" rows={thesis.nextEvidence} warning />
        </div>
      </details>
    </article>
  );
}
