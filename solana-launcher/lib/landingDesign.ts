export type LandingIconKey =
  | "arrowRight"
  | "barChart"
  | "check"
  | "rocket"
  | "search"
  | "shield"
  | "smartphone"
  | "sparkles"
  | "trending"
  | "zap";

export type LandingTone = "primary" | "ghost";

export const landingDesign = {
  shell: {
    pageClassName: "min-h-screen overflow-hidden",
    containerClassName: "mx-auto flex min-h-screen w-full max-w-7xl flex-col px-5 py-6 sm:px-8 lg:px-10",
  },

  header: {
    brandIcon: "sparkles" as LandingIconKey,
    brandKey: "landing.brandTag",
    subtitleKey: "landing.subtitle",
    actions: [
      {
        labelKey: "landing.enterApp",
        href: "/login",
        icon: "arrowRight" as LandingIconKey,
        tone: "ghost" as LandingTone,
      },
    ],
  },

  hero: {
    badgeIcon: "check" as LandingIconKey,
    badgeKey: "landing.authBadge",
    titleKey: "landing.heroTitle",
    subtitleKey: "landing.heroSubtitle",
    actions: [
      {
        labelKey: "landing.exploreFeatures",
        href: "#features",
        tone: "ghost" as LandingTone,
      },
    ],
  },

  metrics: [
    { labelKey: "landing.metric.launches", value: "12.8K+" },
    { labelKey: "landing.metric.signals", value: "4.2M" },
    { labelKey: "landing.metric.authFlows", value: "1" },
  ],

  trustBadges: [
    { icon: "smartphone" as LandingIconKey, labelKey: "landing.trust1" },
    { icon: "zap" as LandingIconKey, labelKey: "landing.trust2" },
    { icon: "shield" as LandingIconKey, labelKey: "landing.trust3" },
  ],

  visual: {
    badge: "Hologram Pro",
    kickerKey: "landing.liveOverview",
    titleKey: "landing.surfaceTitle",
    panelLabel: "Plasma Sweep / Hologram",
    statusKey: "landing.ready",
    body: "Shared landing primitives now mirror the Telegram Mini App design language.",
    outerGlowClassName:
      "absolute inset-0 -z-10 rounded-[2rem] bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.45),transparent_30%),radial-gradient(circle_at_bottom_right,rgba(192,132,252,0.34),transparent_32%)] blur-3xl",
    frameClassName:
      "rounded-[2rem] border border-cyan-200/20 bg-black/35 p-4 shadow-2xl backdrop-blur-xl sm:p-6",
    stageClassName:
      "relative min-h-[460px] overflow-hidden rounded-[1.5rem] border border-cyan-200/20 bg-[radial-gradient(circle_at_top,rgba(34,211,238,0.28),transparent_28%),radial-gradient(circle_at_bottom,rgba(192,132,252,0.18),transparent_34%),linear-gradient(160deg,rgba(255,255,255,0.08),rgba(255,255,255,0.02))] p-5 sm:p-6",
    overlayClassName:
      "absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(10,15,23,0),rgba(10,15,23,0.58)_72%)]",
    strandProps: {
      colors: ["#FFFFFF", "#C084FC", "#22D3EE", "#4ADE80", "#A78BFA"],
      count: 6,
      speed: 1.15,
      amplitude: 1.15,
      waviness: 1.4,
      thickness: 1.15,
      glow: 5.2,
      taper: 1.8,
      spread: 1.05,
      intensity: 1,
      saturation: 2,
      opacity: 1,
      scale: 1.7,
    },
  },

  steps: [
    { num: "01", icon: "smartphone" as LandingIconKey, titleKey: "landing.step1Title", descKey: "landing.step1Desc" },
    { num: "02", icon: "search" as LandingIconKey, titleKey: "landing.step2Title", descKey: "landing.step2Desc" },
    { num: "03", icon: "trending" as LandingIconKey, titleKey: "landing.step3Title", descKey: "landing.step3Desc" },
  ],

  features: [
    { icon: "rocket" as LandingIconKey, titleKey: "landing.feature.launchFast.title", textKey: "landing.feature.launchFast.text" },
    { icon: "shield" as LandingIconKey, titleKey: "landing.feature.socialAuth.title", textKey: "landing.feature.socialAuth.text" },
    { icon: "barChart" as LandingIconKey, titleKey: "landing.feature.walletAware.title", textKey: "landing.feature.walletAware.text" },
    { icon: "zap" as LandingIconKey, titleKey: "landing.feature.securityFirst.title", textKey: "landing.feature.securityFirst.text" },
  ],

  cta: {
    titleKey: "landing.ctaTitle",
    subtitleKey: "landing.ctaSubtitle",
    buttonKey: "landing.ctaButton",
  },
};
