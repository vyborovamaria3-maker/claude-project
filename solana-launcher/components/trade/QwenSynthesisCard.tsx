import { BrainCircuit, ChevronDown, Scale, ShieldAlert, TrendingUp } from "lucide-react";
import type { QwenSynthesis } from "@/lib/trade/qwen-synthesis";

function Row({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="rounded-xl border border-bg-border bg-bg-card p-3.5">
      <div className="text-[9px] font-semibold uppercase tracking-wider text-content-faint">{label}</div>
      <p className="mt-2 text-[11px] leading-5 text-content-muted">{value}</p>
    </div>
  );
}

function BulletList({ title, rows }: { title: string; rows: string[] }) {
  if (!rows.length) return null;
  return (
    <div className="rounded-xl border border-bg-border bg-bg-card p-3.5">
      <div className="text-[9px] font-semibold uppercase tracking-wider text-content-faint">{title}</div>
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

export default function QwenSynthesisCard({ synthesis }: { synthesis: QwenSynthesis }) {
  return (
    <article className="surface-panel overflow-hidden rounded-2xl border border-bg-border">
      <div className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <BrainCircuit className="h-4 w-4 text-neon-purple" />
              <div className="text-[9px] font-semibold uppercase tracking-[0.15em] text-content-faint">
                Независимый анализ Qwen
              </div>
            </div>
            <h2 className="mt-2 max-w-4xl text-sm font-semibold leading-6 text-content">
              {synthesis.headline}
            </h2>
          </div>
          <div className="rounded-lg border border-neon-purple/25 bg-neon-purple/5 px-3 py-2 text-right">
            <div className="text-[8px] uppercase tracking-wider text-content-faint">Уверенность AI</div>
            <div className="mt-1 font-mono text-sm font-bold text-neon-purple">
              {Math.round(synthesis.confidence)}%
            </div>
          </div>
        </div>

        <p className="mt-3 max-w-5xl text-[11px] leading-5 text-content-muted">
          {synthesis.summary}
        </p>

        {synthesis.available && (
          <div className="mt-4 grid gap-3 xl:grid-cols-3">
            <Row label="Что Qwen видит в рынке" value={synthesis.marketState} />
            <Row label="Что Qwen видит в social" value={synthesis.socialState} />
            <Row label="Манипуляция / координация" value={synthesis.manipulationAssessment} />
          </div>
        )}

        {synthesis.entryVerdict && (
          <div className="mt-3 rounded-xl border border-primary/20 bg-primary/5 p-3.5">
            <div className="flex items-center gap-2 text-[9px] font-semibold uppercase tracking-wider text-primary">
              <Scale className="h-3.5 w-3.5" />
              Qwen о текущей цене и входе
            </div>
            <p className="mt-2 text-[12px] leading-5 text-content">
              {synthesis.entryVerdict}
            </p>
          </div>
        )}

        <div className="mt-3 grid gap-3 xl:grid-cols-2">
          {synthesis.bullCase && (
            <div className="rounded-xl border border-success/20 bg-success/5 p-3.5">
              <div className="flex items-center gap-2 text-[9px] font-semibold uppercase tracking-wider text-success">
                <TrendingUp className="h-3.5 w-3.5" />
                Bull case
              </div>
              <p className="mt-2 text-[11px] leading-5 text-content-muted">{synthesis.bullCase}</p>
            </div>
          )}
          {synthesis.bearCase && (
            <div className="rounded-xl border border-danger/20 bg-danger/5 p-3.5">
              <div className="flex items-center gap-2 text-[9px] font-semibold uppercase tracking-wider text-danger">
                <ShieldAlert className="h-3.5 w-3.5" />
                Bear case
              </div>
              <p className="mt-2 text-[11px] leading-5 text-content-muted">{synthesis.bearCase}</p>
            </div>
          )}
        </div>
      </div>

      <details data-collapse="qwen-synthesis-details" data-default-open="false" className="group border-t border-bg-border">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-[10px] font-semibold text-content-muted hover:bg-bg-elevated/50">
          <span>Почему Qwen так решил · противоречия · неизвестные</span>
          <ChevronDown className="h-4 w-4 transition-transform duration-200 group-open:rotate-180" />
        </summary>
        <div className="grid gap-3 border-t border-bg-border p-4 xl:grid-cols-3">
          <BulletList title="Ключевые рассуждения" rows={synthesis.reasoning} />
          <BulletList title="Что изменит вывод" rows={synthesis.whatWouldChange} />
          <div className="space-y-3">
            <BulletList title="Противоречия" rows={synthesis.contradictions} />
            <BulletList title="Неизвестные" rows={synthesis.unknowns} />
          </div>
        </div>
      </details>
    </article>
  );
}
