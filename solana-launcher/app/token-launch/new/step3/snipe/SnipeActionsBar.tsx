"use client";

import { useState } from "react";
import {
  RefreshCw,
  Plus,
  PlusCircle,
  Globe,
  Download,
  Send,
  Flame,
} from "lucide-react";
import FundYourWalletsCard from "../shared/FundYourWalletsCard";
import GenerateWalletsCard from "../shared/GenerateWalletsCard";
import MyWalletsCard from "../shared/MyWalletsCard";
import ImportWalletsCard from "../shared/ImportWalletsCard";
import FundWalletsCard from "../shared/FundWalletsCard";
import WarmupWalletsCard from "../shared/WarmupWalletsCard";

type Action = {
  tag: string;
  label: string;
  icon: React.ReactNode;
  disabled?: boolean;
  onClick?: () => void;
};

export default function SnipeActionsBar() {
  const [devActive, setDevActive] = useState(false);
  const [createActive, setCreateActive] = useState(false);
  const [myWalletsActive, setMyWalletsActive] = useState(false);
  const [importActive, setImportActive] = useState(false);
  const [fundActive, setFundActive] = useState(false);
  const [warmupActive, setWarmupActive] = useState(false);

  const actions: Action[] = [
    {
      tag: "step3.snipe.action.refresh",
      label: "Refresh",
      icon: <RefreshCw className="w-4 h-4" />,
      disabled: true,
    },
    {
      tag: "step3.snipe.action.my_wallets",
      label: "My Wallets",
      icon: <Globe className="w-4 h-4" />,
      onClick: () => setMyWalletsActive((v) => !v),
    },
    {
      tag: "step3.snipe.action.import",
      label: "Import",
      icon: <Download className="w-4 h-4" />,
      onClick: () => setImportActive((v) => !v),
    },
    { tag: "step3.snipe.action.fund", label: "Fund", icon: <Send className="w-4 h-4" />, onClick: () => setFundActive((v) => !v) },
    {
      tag: "step3.snipe.action.warmup",
      label: "Warmup",
      icon: <Flame className="w-4 h-4" />,
      onClick: () => setWarmupActive(true),
    },
  ];

  return (
    <div className="space-y-3">
      {devActive && <FundYourWalletsCard />}
      {createActive && <GenerateWalletsCard defaultRole="snipe" />}
      {myWalletsActive && <MyWalletsCard onClose={() => setMyWalletsActive(false)} />}
      {importActive && <ImportWalletsCard onClose={() => setImportActive(false)} defaultRole="snipe" />}
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

      <div
        data-tag="step3.snipe.actions"
        className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-7 gap-2 w-full"
      >
        <button
          type="button"
          data-tag={actions[0].tag}
          disabled={actions[0].disabled}
          onClick={actions[0].onClick}
          className="flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-bg-border bg-bg-card/40 text-sm text-white/80 hover:border-white/20 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition whitespace-nowrap"
        >
          {actions[0].icon}
          <span className="hidden sm:inline">{actions[0].label}</span>
        </button>

        <button
          type="button"
          data-tag="step3.snipe.action.dev"
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
          data-tag="step3.snipe.action.create"
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

        {actions.slice(1).map((a) => (
          <button
            key={a.tag}
            type="button"
            data-tag={a.tag}
            disabled={a.disabled}
            onClick={a.onClick}
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