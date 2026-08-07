export type SiteIconKey =
  | "barChart"
  | "bell"
  | "check"
  | "database"
  | "globe"
  | "history"
  | "layoutDashboard"
  | "logOut"
  | "package"
  | "rocket"
  | "search"
  | "settings"
  | "trending"
  | "trophy"
  | "twitter"
  | "wallet"
  | "warning";

export type SiteNavMode = "launch" | "trade";

export interface SiteNavItem {
  href: string;
  labelKey: string;
  icon: SiteIconKey;
  tag: string;
}

export const siteDesign = {
  publicRoutes: ["/login", "/auth", "/miniapp"],

  /**
   * Main redesign controls for the whole app.
   * Change these classes first when you want to quickly restyle pages,
   * cards, tabs, inputs, tables, or buttons across all site sections.
   */
  page: {
    containerClassName: "site-page w-full min-w-0 max-w-[1480px] mx-auto space-y-6 py-6 sm:py-8",
    compactContainerClassName: "site-page w-full min-w-0 max-w-[1400px] mx-auto space-y-5 py-6",
    heroClassName: "site-hero surface-panel-hero relative overflow-hidden p-5 sm:p-6",
    panelClassName: "site-panel surface-panel rounded-2xl border border-bg-border p-5",
    panelTightClassName: "site-panel surface-panel rounded-xl border border-bg-border p-4",
    titleClassName: "text-2xl md:text-3xl font-bold tracking-tight text-content",
    subtitleClassName: "text-sm leading-6 text-content-muted",
    eyebrowClassName:
      "site-eyebrow inline-flex items-center gap-2 rounded-full border border-bg-border/70 bg-[color-mix(in_srgb,var(--theme-bg-elevated)_72%,transparent)] px-3 py-1 text-xs font-semibold text-content-muted",
  },

  controls: {
    inputClassName:
      "site-input w-full rounded-xl border border-bg-border bg-[linear-gradient(180deg,var(--theme-bg-elevated),var(--theme-bg-card))] px-3 py-2 text-sm text-content placeholder:text-content-faint outline-none transition focus:border-primary-border focus:ring-2 focus:ring-[color-mix(in_srgb,var(--theme-ring)_42%,transparent)]",
    iconButtonClassName:
      "site-icon-button rounded-lg border border-bg-border bg-[linear-gradient(180deg,var(--theme-bg-elevated),var(--theme-bg-card))] p-2 text-content-muted transition hover:border-primary-border hover:text-content",
    actionButtonClassName:
      "site-action-button inline-flex items-center justify-center gap-2 rounded-xl border border-bg-border bg-[linear-gradient(180deg,var(--theme-bg-elevated),var(--theme-bg-card))] px-4 py-2.5 text-sm font-semibold text-content transition hover:border-primary-border hover:shadow-[0_14px_34px_-24px_var(--theme-primary-glow)]",
    primaryActionClassName:
      "site-primary-action inline-flex items-center justify-center gap-2 rounded-xl border border-primary-border bg-[linear-gradient(180deg,color-mix(in_srgb,var(--theme-primary)_100%,white_12%),var(--theme-primary))] px-4 py-2.5 text-sm font-semibold text-primary-foreground transition hover:brightness-110",
  },

  tabsShared: {
    listClassName: "site-tabs flex flex-wrap gap-2 rounded-2xl border border-bg-border bg-[linear-gradient(180deg,var(--theme-bg-elevated),var(--theme-bg-card))] p-2",
    gridClassName: "site-tabs grid grid-cols-1 gap-2 rounded-2xl border border-bg-border bg-[linear-gradient(180deg,var(--theme-bg-elevated),var(--theme-bg-card))] p-2 sm:grid-cols-2 xl:grid-cols-3",
    tabClassName:
      "site-tab inline-flex items-center justify-center gap-2 rounded-xl border px-3 py-2 text-xs font-semibold transition-all",
    cardTabClassName:
      "site-tab-card relative overflow-hidden rounded-2xl border px-4 py-4 text-left transition-all duration-200",
    activeClassName:
      "site-tab-active border-primary-border bg-[linear-gradient(145deg,color-mix(in_srgb,var(--theme-primary)_18%,transparent),color-mix(in_srgb,var(--theme-secondary)_10%,transparent),var(--theme-bg-card))] text-content shadow-[0_14px_34px_-22px_var(--theme-primary-glow)]",
    inactiveClassName:
      "border-bg-border bg-[linear-gradient(180deg,var(--theme-bg-elevated),var(--theme-bg-card))] text-content-muted hover:border-primary-border hover:text-content",
  },

  table: {
    shellClassName: "site-table surface-table overflow-hidden rounded-xl border border-bg-border",
    headerClassName: "sticky top-0 border-b border-bg-border bg-bg-card text-content-muted",
    rowClassName: "border-t border-bg-border transition hover:bg-[color-mix(in_srgb,var(--page-accent)_7%,transparent)]",
  },

  shell: {
    publicMainClassName: "min-h-screen min-w-0 overflow-x-hidden",
    publicBackgroundClassName:
      "fixed inset-0 -z-10 bg-[radial-gradient(circle_at_20%_20%,var(--page-glow,var(--theme-ambient-glow,rgba(244,63,94,0.12))),transparent_26%),radial-gradient(circle_at_80%_0%,var(--page-glow-2,var(--theme-cool-glow,rgba(192,132,252,0.1))),transparent_24%),linear-gradient(180deg,var(--theme-bg-soft),var(--theme-bg))]",
    sidebarClassName: "app-sidebar fixed inset-y-0 left-0 z-50 w-64 flex flex-col overflow-y-auto glass",
    contentClassName: "app-content min-h-screen flex flex-col min-w-0 overflow-x-hidden relative z-0",
    appBackgroundClassName:
      "pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(circle_at_20%_0%,var(--page-glow,var(--theme-warm-glow,rgba(244,165,28,0.10))),transparent_22%),radial-gradient(circle_at_85%_10%,var(--page-glow-2,var(--theme-cool-glow,rgba(29,155,240,0.08))),transparent_20%),radial-gradient(circle_at_50%_90%,var(--theme-ambient-glow,rgba(20,241,149,0.08)),transparent_28%),linear-gradient(180deg,var(--theme-bg-soft),var(--theme-bg))]",
    mainClassName: "min-w-0 flex-1 px-4 py-5 overflow-x-hidden sm:px-5 sm:py-6",
  },

  buttonClasses: {
    icon:
      "relative rounded-lg border border-transparent p-2 text-content-muted transition hover:border-bg-border hover:bg-bg-elevated hover:text-content",
    nav:
      "group flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all w-full border",
    tab:
      "tab-chip flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold transition-all",
  },

  tabs: [
    {
      id: "launch" as SiteNavMode,
      href: "/launch-dashboard",
      labelKey: "nav.tabLaunch",
      icon: "rocket" as SiteIconKey,
      tag: "nav.tab_launch",
      activeClassName: "tab-chip-active bg-primary-soft text-primary border border-primary-border",
      inactiveClassName: "text-content-muted hover:text-content",
    },
    {
      id: "trade" as SiteNavMode,
      href: "/trade-dashboard",
      labelKey: "nav.tabTrade",
      icon: "trending" as SiteIconKey,
      tag: "nav.tab_trade",
      activeClassName:
        "tab-chip-active bg-[color-mix(in_srgb,var(--theme-secondary)_18%,transparent)] text-[color:var(--theme-secondary)] border border-[color-mix(in_srgb,var(--theme-secondary)_30%,transparent)]",
      inactiveClassName: "text-content-muted hover:text-content",
    },
  ],

  nav: {
    launch: [
      { href: "/launch-dashboard", labelKey: "nav.launchDashboard", icon: "layoutDashboard", tag: "nav.launch_dashboard" },
      { href: "/token-launch", labelKey: "nav.tokenLaunch", icon: "rocket", tag: "nav.token_launch" },
      { href: "/bundles", labelKey: "nav.bundles", icon: "package", tag: "nav.bundles" },
      { href: "/cto-wallets", labelKey: "nav.ctoWallets", icon: "wallet", tag: "nav.cto_wallets" },
    ] satisfies SiteNavItem[],
    trade: [
      { href: "/trade-dashboard", labelKey: "nav.tradeDashboard", icon: "layoutDashboard", tag: "nav.trade_dashboard" },
      { href: "/trade/analysis", labelKey: "nav.tradeAnalysis", icon: "search", tag: "nav.trade_analysis" },
      { href: "/trade/leaderboard", labelKey: "nav.tradeLeaderboard", icon: "trophy", tag: "nav.trade_leaderboard" },
      { href: "/trade/history", labelKey: "nav.tradeHistory", icon: "history", tag: "nav.trade_history" },
    ] satisfies SiteNavItem[],
    common: [
      { href: "/database", labelKey: "nav.database", icon: "database", tag: "nav.database" },
      { href: "/database/wallets", labelKey: "nav.databaseWallets", icon: "wallet", tag: "nav.database_wallets" },
      { href: "/market-overview", labelKey: "nav.marketOverview", icon: "barChart", tag: "nav.market_overview" },
      { href: "/settings", labelKey: "nav.settings", icon: "settings", tag: "nav.settings" },
    ] satisfies SiteNavItem[],
  },

  navActive: {
    launch:
      "bg-primary-soft text-primary border-primary-border shadow-[0_10px_26px_-18px_color-mix(in_srgb,var(--theme-primary)_80%,transparent)]",
    trade:
      "bg-[color-mix(in_srgb,var(--theme-secondary)_16%,transparent)] text-[color:var(--theme-secondary)] border-[color-mix(in_srgb,var(--theme-secondary)_30%,transparent)] shadow-[0_10px_26px_-18px_color-mix(in_srgb,var(--theme-primary)_80%,transparent)]",
    inactive: "text-content-soft hover:text-content hover:bg-bg-elevated/80 border-transparent hover:border-bg-border/80",
  },

  sidebar: {
    shellClassName: "border-r border-bg-border/70 bg-bg/78 backdrop-blur-xl flex flex-col flex-1",
    tabsWrapClassName: "px-3 pt-4 pb-2",
    tabsGridClassName:
      "grid grid-cols-2 gap-1 rounded-xl border border-bg-border bg-[linear-gradient(180deg,var(--theme-bg-elevated),var(--theme-bg-card))] p-1.5 shadow-surface-soft",
    navClassName: "flex-1 w-full px-3 py-3 space-y-1",
    sessionClassName:
      "px-4 py-3 border-t border-bg-border flex items-center gap-3 bg-[linear-gradient(180deg,var(--theme-bg-elevated),var(--theme-bg-card))]",
  },

  header: {
    shellClassName:
      "h-[72px] min-w-0 max-w-full border-b border-bg-border/70 bg-bg/72 backdrop-blur-xl flex items-center glass-strong",
    innerClassName: "w-full min-w-0 px-4 sm:px-5 flex items-center gap-2 sm:gap-4",
    notificationAriaKey: "header.notificationsAria",
  },
};