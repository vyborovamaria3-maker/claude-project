"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, GitBranch, Loader2 } from "lucide-react";
import { siteDesign } from "@/lib/siteDesign";

type RelatedWallet = {
  sourceWallet: string;
  address: string;
  similarity_score: number;
  shared_tokens_count: number;
  first_interaction_date?: string | null;
  classification: string;
  ownership_claim: boolean;
};

type RelatedResponse = {
  items?: RelatedWallet[];
  ownershipClaim?: boolean;
  error?: string;
};

function shortAddress(value: string) {
  return value.length > 16 ? `${value.slice(0, 7)}…${value.slice(-6)}` : value;
}

export default function KOLRelatedWalletsPanel({ handle }: { handle: string }) {
  const [data, setData] = useState<RelatedWallet[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(`/api/kols/related/${encodeURIComponent(handle)}`, { cache: "no-store" });
        const payload = (await response.json()) as RelatedResponse;
        if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
        if (!cancelled) setData(payload.items ?? []);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Related wallets unavailable");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [handle]);

  return (
    <section className={`${siteDesign.page.compactContainerClassName} !pt-0`} data-tag="trade.kols_related_wallets">
      <div className="surface-panel rounded-2xl border border-bg-border p-4">
        <div className="flex items-start gap-2">
          <GitBranch className="mt-0.5 h-4 w-4 text-[color:var(--theme-secondary)]" />
          <div>
            <h2 className="text-sm font-semibold text-content">Possible related wallets</h2>
            <p className="mt-1 text-[11px] leading-5 text-content-muted">
              Эти адреса связаны только через существующий wallet similarity graph. Они не считаются кошельками @{handle} без отдельного identity evidence.
            </p>
          </div>
        </div>

        {loading ? <div className="mt-4 flex items-center gap-2 text-xs text-content-muted"><Loader2 className="h-4 w-4 animate-spin" /> Проверяю wallet graph…</div> : null}
        {error ? <div className="mt-4 flex items-center gap-2 text-xs text-danger"><AlertTriangle className="h-4 w-4" /> {error}</div> : null}
        {!loading && !error && data.length === 0 ? <div className="mt-4 text-xs text-content-muted">Связанные кандидаты пока не найдены.</div> : null}

        {data.length ? (
          <div className="mt-4 grid gap-2 md:grid-cols-2">
            {data.map((wallet) => (
              <div key={`${wallet.sourceWallet}:${wallet.address}`} className="rounded-xl border border-bg-border bg-bg-elevated/40 p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-mono text-xs text-content">{shortAddress(wallet.address)}</span>
                  <span className="rounded-full border border-amber-400/20 bg-amber-400/10 px-2 py-1 text-[9px] font-semibold text-amber-300">possible</span>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2 text-[10px] text-content-muted">
                  <div>Similarity <span className="font-mono text-content">{(wallet.similarity_score * 100).toFixed(1)}%</span></div>
                  <div>Shared tokens <span className="font-mono text-content">{wallet.shared_tokens_count}</span></div>
                </div>
                <div className="mt-2 truncate font-mono text-[9px] text-content-faint">via {shortAddress(wallet.sourceWallet)}</div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
