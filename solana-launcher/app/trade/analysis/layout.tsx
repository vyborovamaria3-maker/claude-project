"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Activity, Twitter } from "lucide-react";
import clsx from "clsx";
import { siteDesign } from "@/lib/siteDesign";

const tabs = [
  {
    href: "/trade/analysis",
    label: "On-chain",
    icon: Activity,
    matches: (pathname: string) => pathname === "/trade/analysis",
  },
  {
    href: "/trade/analysis/x",
    label: "X",
    icon: Twitter,
    matches: (pathname: string) =>
      pathname.startsWith("/trade/analysis/x") || pathname.startsWith("/trade/analysis/social"),
  },
];

export default function TradeAnalysisLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const mint = params.get("mint")?.trim() || "";

  return (
    <div className="space-y-5" data-tag="trade.analysis.layout">
      <div className={siteDesign.tabsShared.listClassName} aria-label="Analysis mode">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const active = tab.matches(pathname);
          const href = mint ? `${tab.href}?mint=${encodeURIComponent(mint)}` : tab.href;
          return (
            <Link
              key={tab.href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={clsx(
                siteDesign.tabsShared.tabClassName,
                active ? siteDesign.tabsShared.activeClassName : siteDesign.tabsShared.inactiveClassName,
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {tab.label}
            </Link>
          );
        })}
      </div>
      {children}
    </div>
  );
}
