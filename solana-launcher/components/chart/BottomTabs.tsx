"use client";
// data-tag: components.chart.bottom_tabs
// GMGN-style tabs below the chart: Trades, Holders, TopTraders, DCA, Pool, Dev, Bundler

import React, { useEffect, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import DevForensicsTab from "./tabs/DevForensicsTab";
import { loadPageState, savePageState } from "@/lib/pageState";

interface Props {
  mint: string;
}

type TabKey = "dev-forensics";

const TABS: { key: TabKey; label: string }[] = [
  { key: "dev-forensics", label: "Dev Forensics" },
];

const getBottomTabsStateKey = (mint: string) => `chart.bottom-tabs.v1:${mint}`;

const BottomTabs = React.memo(function BottomTabs({ mint }: Props) {
  const [active, setActive] = useState<TabKey>("dev-forensics");
  const [isOpen, setIsOpen] = useState(true);
  const [hasRestoredState, setHasRestoredState] = useState(false);

  useEffect(() => {
    const restored = loadPageState<{ active: TabKey; isOpen: boolean } | null>(getBottomTabsStateKey(mint), null);
    setActive(restored?.active ?? "dev-forensics");
    setIsOpen(restored?.isOpen ?? true);
    setHasRestoredState(true);
  }, [mint]);

  useEffect(() => {
    if (!hasRestoredState) return;
    savePageState(getBottomTabsStateKey(mint), { active, isOpen });
  }, [mint, active, isOpen, hasRestoredState]);

  return (
    <div className={[
      "border-t border-[#1a1a2e] bg-[#0a0a14] flex flex-col transition-all duration-300",
      isOpen ? "" : "",
    ].join(" ")} style={{ minHeight: isOpen ? 280 : 40 }}>
      <div className="flex items-center justify-between px-3 pt-2 border-b border-[#1a1a2e]">
        <div className="flex items-center gap-1 overflow-x-auto">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => {
                setActive(t.key);
                if (!isOpen) setIsOpen(true);
              }}
              className={[
                "px-3 py-1.5 text-[11px] font-semibold rounded-t whitespace-nowrap transition-colors",
                active === t.key && isOpen
                  ? "bg-[#1a1a2e] text-white border border-b-0 border-[#1a1a2e]"
                  : "text-[#d1d4dc]/50 hover:text-[#d1d4dc]",
              ].join(" ")}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setIsOpen((v) => !v)}
          className="p-1.5 rounded text-[#d1d4dc]/40 hover:text-[#d1d4dc] hover:bg-[#1a1a2e] transition"
          title={isOpen ? "Свернуть" : "Развернуть"}
        >
          {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
        </button>
      </div>

      {isOpen && (
        <div className="flex-1 overflow-auto custom-scrollbar">
          {active === "dev-forensics" && <DevForensicsTab mint={mint} />}
        </div>
      )}
    </div>
  );
});

export default BottomTabs;
