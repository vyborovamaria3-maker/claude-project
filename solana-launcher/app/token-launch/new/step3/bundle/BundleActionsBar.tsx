"use client";

import { useState } from "react";
import { RefreshCw, Plus, PlusCircle, Globe, Download, Send, Flame, Clock } from "lucide-react";
import FundYourWalletsCard from "../shared/FundYourWalletsCard";
import GenerateWalletsCard from "../shared/GenerateWalletsCard";
import MyWalletsCard from "../shared/MyWalletsCard";
import ImportWalletsCard from "../shared/ImportWalletsCard";
import FundWalletsCard from "../shared/FundWalletsCard";
import WarmupWalletsCard from "../shared/WarmupWalletsCard";
import AdaptiveGenerateCard from "../shared/AdaptiveGenerateCard";
import type { WalletRole } from "@/lib/walletStore";

// data-tag: step3.bundle.actions
export default function BundleActionsBar({
  defaultRole = "bundle",
}: {
  defaultRole?: WalletRole;
}) {
  const [devActive, setDevActive] = useState(false);
  const [createActive, setCreateActive] = useState(false);
  const [myWalletsActive, setMyWalletsActive] = useState(false);
  const [importActive, setImportActive] = useState(false);
  const [fundActive, setFundActive] = useState(false);
  const [warmupActive, setWarmupActive] = useState(false);
  const [adaptiveActive, setAdaptiveActive] = useState(false);

  const refresh = { tag: "step3.bundle.action.refresh", label: "Refresh", icon: <RefreshCw className="w-4 h-4" />, disabled: true };
  const actions = [
    {
      tag: "step3.bundle.action.my_wallets",
      label: "My Wallets",
      icon: <Globe className="w-4 h-4" />,
      onClick: () => setMyWalletsActive((v) => !v),
      disabled: false,
    },
    { tag: "step3.bundle.action.import", label: "Import", icon: <Download className="w-4 h-4" />, onClick: () => setImportActive((v) => !v), disabled: false },
    { tag: "step3.bundle.action.fund", label: "Fund", icon: <Send className="w-4 h-4" />, onClick: () => setFundActive((v) => !v), disabled: false },
    { tag: "step3.bundle.action.warmup", label: "Warmup", icon: <Flame className="w-4 h-4" />, onClick: () => setWarmupActive(true), disabled: false },
  ];

  return (
    <div className="space-y-3">
      {devActive && <FundYourWalletsCard />}
      {createActive && <GenerateWalletsCard defaultRole={defaultRole} />}
      {myWalletsActive && <MyWalletsCard onClose={() => setMyWalletsActive(false)} />}
      {importActive && <ImportWalletsCard onClose={() => setImportActive(false)} defaultRole={defaultRole} />}
      {fundActive && <FundWalletsCard onClose={() => setFundActive(false)} />}
      {warmupActive && (
        <WarmupWalletsCard
          onClose={() => setWarmupActive(false)}
          onFundRequest={() => {
            setWarmupActive(false);
            setFundActive(true);
          }}
        />
      )}
      {adaptiveActive && <AdaptiveGenerateCard defaultRole={defaultRole} onClose={() => setAdaptiveActive(false)} />}

      <div data-tag="step3.bundle.actions" className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-7 gap-2 w-full">
        <button
          type="button"
          data-tag={refresh.tag}
          disabled={refresh.disabled}
          className="flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-bg-border bg-bg-card/40 text-sm text-white/80 hover:border-white/20 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition whitespace-nowrap"
        >
          {refresh.icon}
          <span className="hidden sm:inline">{refresh.label}</span>
        </button>

        <button
          type="button"
          data-tag="step3.bundle.action.dev"
          onClick={() => setDevActive((v) => !v)}
          className={[
            "flex items-center justify-center gap-2 px-3 py-2 rounded-lg border text-sm transition whitespace-nowrap",
            devActive
              ? "border-neon-green/50 bg-neon-green/10 text-neon-green"
              : "border-bg-border bg-bg-card/40 text-white/80 hover:border-white/20 hover:text-white",
          ].join(" ")}
        >
          <Plus className="w-4 h-4" />
          <span className="hidden sm:inline">{devActive ? "Dev (1/1)" : "Dev"}</span>
        </button>

        <button
          type="button"
          data-tag="step3.bundle.action.create"
          onClick={() => setCreateActive((v) => !v)}
          className={[
            "flex items-center justify-center gap-2 px-3 py-2 rounded-lg border text-sm transition whitespace-nowrap",
            createActive
              ? "border-neon-green/50 bg-neon-green/10 text-neon-green"
              : "border-bg-border bg-bg-card/40 text-white/80 hover:border-white/20 hover:text-white",
          ].join(" ")}
        >
          <PlusCircle className="w-4 h-4" />
          <span className="hidden sm:inline">Create</span>
        </button>

        <button
          type="button"
          data-tag="step3.bundle.action.adaptive_generate"
          onClick={() => setAdaptiveActive((v) => !v)}
          className={[
            "flex items-center justify-center gap-2 px-3 py-2 rounded-lg border text-sm transition whitespace-nowrap",
            adaptiveActive
              ? "border-neon-purple/50 bg-neon-purple/10 text-neon-purple"
              : "border-bg-border bg-bg-card/40 text-white/80 hover:border-white/20 hover:text-white",
          ].join(" ")}
        >
          <Clock className="w-4 h-4" />
          <span className="hidden sm:inline">Adaptive</span>
        </button>

        {actions.map((a) => (
          <button
            key={a.tag}
            type="button"
            data-tag={a.tag}
            disabled={!!a.disabled}
            onClick={a.onClick || undefined}
            className="flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-bg-border bg-bg-card/40 text-sm text-white/80 hover:border-white/20 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition whitespace-nowrap"
          >
            {a.icon}
            <span className="hidden sm:inline">{a.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
