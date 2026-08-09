"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo } from "react";
import {
  BarChart3,
  Bell,
  CheckCircle2,
  Database,
  Globe,
  History,
  LayoutDashboard,
  LogOut,
  Package,
  Rocket,
  Search,
  Settings,
  TrendingUp,
  Trophy,
  Twitter,
  Wallet,
  AlertTriangle,
} from "lucide-react";
import clsx from "clsx";
import { useI18n } from "@/components/providers/I18nProvider";
import { currentUser } from "@/lib/mockData";
import { siteDesign, type SiteIconKey, type SiteNavMode } from "@/lib/siteDesign";

const icons = {
  barChart: BarChart3,
  bell: Bell,
  check: CheckCircle2,
  database: Database,
  globe: Globe,
  history: History,
  layoutDashboard: LayoutDashboard,
  logOut: LogOut,
  package: Package,
  rocket: Rocket,
  search: Search,
  settings: Settings,
  trending: TrendingUp,
  trophy: Trophy,
  twitter: Twitter,
  wallet: Wallet,
  warning: AlertTriangle,
} satisfies Record<SiteIconKey, typeof Rocket>;

export default function SidebarNav() {
  const { t } = useI18n();
  const translate = (key: string) => t(key as Parameters<typeof t>[0]);
  const pathname = usePathname();

  const activeTab: SiteNavMode = useMemo(
    () => (
      pathname.startsWith("/trade") || pathname === "/x-analysis" || pathname === "/telegram-intelligence"
        ? "trade"
        : "launch"
    ),
    [pathname]
  );

  const navItems = siteDesign.nav[activeTab];
  const allNavItems = useMemo(
    () => [...navItems, ...siteDesign.nav.common].filter((item) => !item.href.startsWith("/database")),
    [navItems]
  );

  const activeHref = useMemo(() => {
    const matches = allNavItems.filter((item) => pathname === item.href || pathname.startsWith(`${item.href}/`));
    return matches.sort((a, b) => b.href.length - a.href.length)[0]?.href ?? null;
  }, [allNavItems, pathname]);

  return (
    <aside data-tag="layout.sidebar" className={siteDesign.sidebar.shellClassName}>
      <div className={siteDesign.sidebar.tabsWrapClassName} data-tag="layout.tabs">
        <div className={siteDesign.sidebar.tabsGridClassName}>
          {siteDesign.tabs.map((tab) => {
            const Icon = icons[tab.icon] ?? Rocket;
            const active = activeTab === tab.id;
            return (
              <Link
                key={tab.id}
                href={tab.href}
                aria-label={translate(tab.labelKey)}
                data-tag={tab.tag}
                className={clsx(siteDesign.buttonClasses.tab, active ? tab.activeClassName : tab.inactiveClassName)}
              >
                <Icon className="h-3.5 w-3.5" />
                <span>{translate(tab.labelKey)}</span>
              </Link>
            );
          })}
        </div>
      </div>

      <nav className={siteDesign.sidebar.navClassName} data-tag="layout.nav">
        {allNavItems.map((item) => {
          const active = activeHref === item.href;
          const Icon = icons[item.icon] ?? Rocket;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              data-tag={item.tag}
              className={clsx(
                siteDesign.buttonClasses.nav,
                active ? siteDesign.navActive[activeTab] : siteDesign.navActive.inactive
              )}
            >
              <Icon className="h-4 w-4 shrink-0 transition-transform group-hover:scale-105" />
              <span className="truncate">{translate(item.labelKey)}</span>
            </Link>
          );
        })}
      </nav>

      <div className={siteDesign.sidebar.sessionClassName} data-tag="user.session">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[color-mix(in_srgb,var(--theme-secondary)_40%,transparent)] bg-[color-mix(in_srgb,var(--theme-secondary)_22%,transparent)] text-xs font-bold text-[color:var(--theme-secondary)]">
          U
        </div>
        <div className="flex-1 truncate text-xs text-content-soft">{currentUser.username}</div>
        <Link
          href="/auth"
          className="rounded-lg p-1 text-content-muted transition hover:bg-bg-elevated hover:text-danger"
          aria-label="logout"
          title={translate("nav.exitToLanding")}
        >
          <LogOut className="h-4 w-4" />
        </Link>
      </div>
    </aside>
  );
}
