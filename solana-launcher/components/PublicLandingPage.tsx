"use client";

import Link from "next/link";
import {
  ArrowRight,
  BarChart3,
  CheckCircle2,
  Rocket,
  Search,
  ShieldCheck,
  Smartphone,
  Sparkles,
  TrendingUp,
  Zap,
} from "lucide-react";
import { useI18n } from "@/components/providers/I18nProvider";
import { landingDesign, type LandingIconKey, type LandingTone } from "@/lib/landingDesign";
import LanguageSwitcher from "./LanguageSwitcher";
import Strands from "./Strands";

const icons = {
  arrowRight: ArrowRight,
  barChart: BarChart3,
  check: CheckCircle2,
  rocket: Rocket,
  search: Search,
  shield: ShieldCheck,
  smartphone: Smartphone,
  sparkles: Sparkles,
  trending: TrendingUp,
  zap: Zap,
} satisfies Record<LandingIconKey, typeof Sparkles>;

const actionStyles = {
  primary:
    "inline-flex items-center justify-center gap-2 rounded-2xl border border-neon-green/30 bg-neon-green/15 px-6 py-3.5 text-sm font-semibold text-neon-green transition hover:border-neon-green/50 hover:bg-neon-green/20",
  ghost:
    "inline-flex items-center justify-center gap-2 rounded-2xl border border-white/12 px-6 py-3.5 text-sm font-semibold text-white transition hover:border-white/20 hover:bg-white/[0.03]",
} satisfies Record<LandingTone, string>;

function ActionLink({
  href,
  label,
  icon,
  tone = "ghost",
}: {
  href: string;
  label: string;
  icon?: LandingIconKey;
  tone?: LandingTone;
}) {
  const Icon = icon ? icons[icon] : null;

  return (
    <Link href={href} className={actionStyles[tone]}>
      {label}
      {Icon ? <Icon className="h-4 w-4" /> : null}
    </Link>
  );
}

export default function PublicLandingPage() {
  const { t } = useI18n();
  const translate = (key: string) => t(key as Parameters<typeof t>[0]);
  const BrandIcon = icons[landingDesign.header.brandIcon];
  const BadgeIcon = icons[landingDesign.hero.badgeIcon];

  return (
    <div className={landingDesign.shell.pageClassName}>
      <div className={landingDesign.shell.containerClassName}>
        <header className="flex items-center justify-between gap-4 rounded-3xl border border-white/10 bg-black/20 px-5 py-4 backdrop-blur-xl">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.3em] text-white/45">
              <BrandIcon className="h-3.5 w-3.5 text-neon-green" />
              {translate(landingDesign.header.brandKey)}
            </div>
            <p className="mt-1 text-sm text-white/45">{translate(landingDesign.header.subtitleKey)}</p>
          </div>
          <div className="flex items-center gap-3">
            <LanguageSwitcher />
            {landingDesign.header.actions.map((action) => (
              <ActionLink
                key={action.href}
                href={action.href}
                label={translate(action.labelKey)}
                icon={action.icon}
                tone={action.tone}
              />
            ))}
          </div>
        </header>

        <main className="grid flex-1 items-center gap-12 py-14 lg:grid-cols-[1.05fr_0.95fr] lg:py-16">
          <section className="max-w-2xl">
            <div className="inline-flex items-center gap-2 rounded-full border border-neon-green/25 bg-neon-green/10 px-4 py-2 text-xs font-semibold text-neon-green">
              <BadgeIcon className="h-3.5 w-3.5" />
              {translate(landingDesign.hero.badgeKey)}
            </div>

            <h1 className="mt-6 text-4xl font-black text-white sm:text-5xl lg:text-6xl">
              {translate(landingDesign.hero.titleKey)}
            </h1>

            <p className="mt-5 max-w-xl text-base leading-7 text-white/55 sm:text-lg">
              {translate(landingDesign.hero.subtitleKey)}
            </p>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              {landingDesign.hero.actions.map((action) => (
                <ActionLink key={action.href} href={action.href} label={translate(action.labelKey)} tone={action.tone} />
              ))}
            </div>

            <div className="mt-8 flex flex-wrap items-center gap-4">
              {landingDesign.trustBadges.map((badge) => {
                const Icon = icons[badge.icon];
                return (
                  <div
                    key={badge.labelKey}
                    className="flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs text-white/60"
                  >
                    <Icon className="h-3.5 w-3.5 text-neon-green" />
                    {translate(badge.labelKey)}
                  </div>
                );
              })}
            </div>

            <div className="mt-10 grid grid-cols-3 gap-3 sm:gap-4">
              {landingDesign.metrics.map((metric) => (
                <div key={metric.labelKey} className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                  <div className="text-2xl font-bold text-white sm:text-3xl">{metric.value}</div>
                  <div className="mt-1 text-xs uppercase tracking-[0.2em] text-white/40">{translate(metric.labelKey)}</div>
                </div>
              ))}
            </div>
          </section>

          <section className="relative">
            <div className={landingDesign.visual.outerGlowClassName} />
            <div className={landingDesign.visual.frameClassName}>
              <div className={landingDesign.visual.stageClassName}>
                <div className="pointer-events-none absolute inset-0">
                  <Strands className="absolute inset-0 opacity-100" {...landingDesign.visual.strandProps} />
                </div>
                <div className={landingDesign.visual.overlayClassName} />
                <div className="absolute inset-0 bg-[linear-gradient(135deg,rgba(255,255,255,0.08),transparent_26%,transparent_74%,rgba(255,255,255,0.07))]" />
                <div className="relative">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-xs uppercase tracking-[0.3em] text-white/55">
                        {translate(landingDesign.visual.kickerKey)}
                      </p>
                      <h2 className="mt-2 text-xl font-bold text-white">{translate(landingDesign.visual.titleKey)}</h2>
                    </div>
                    <div className="rounded-full border border-fuchsia-200/40 bg-fuchsia-300/20 px-3 py-1 text-xs font-semibold text-fuchsia-50 shadow-[0_0_28px_rgba(232,121,249,0.35)]">
                      {landingDesign.visual.badge}
                    </div>
                  </div>

                  <div className="mt-6 grid min-h-[350px] items-end gap-3">
                    <div className="rounded-[1.4rem] border border-white/14 bg-black/36 p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.02),0_0_50px_rgba(139,92,246,0.18)] backdrop-blur-md">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-xs uppercase tracking-[0.28em] text-white/55">
                          {landingDesign.visual.panelLabel}
                        </div>
                        <div className="rounded-full border border-neon-green/35 bg-neon-green/20 px-3 py-1 text-xs font-semibold text-neon-green shadow-[0_0_22px_rgba(34,197,94,0.2)]">
                          {translate(landingDesign.visual.statusKey)}
                        </div>
                      </div>
                      <p className="mt-3 text-sm leading-6 text-white/92">{landingDesign.visual.body}</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </main>

        <section className="pb-10">
          <div className="mb-8 text-center">
            <h2 className="text-2xl font-bold text-white sm:text-3xl">{t("landing.howItWorksTitle")}</h2>
            <p className="mt-2 text-sm text-white/50">{t("landing.howItWorksSubtitle")}</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            {landingDesign.steps.map((step) => {
              const Icon = icons[step.icon];
              return (
                <div key={step.num} className="relative rounded-3xl border border-white/10 bg-white/[0.03] p-6">
                  <div className="text-[10px] font-black uppercase tracking-[0.3em] text-neon-green">{step.num}</div>
                  <div className="mt-4 flex h-11 w-11 items-center justify-center rounded-2xl border border-neon-green/20 bg-neon-green/10 text-neon-green">
                    <Icon className="h-5 w-5" />
                  </div>
                  <h3 className="mt-4 text-base font-semibold text-white">{translate(step.titleKey)}</h3>
                  <p className="mt-2 text-sm leading-6 text-white/45">{translate(step.descKey)}</p>
                </div>
              );
            })}
          </div>
        </section>

        <section id="features" className="grid gap-4 pb-10 sm:grid-cols-2 xl:grid-cols-4">
          {landingDesign.features.map((feature) => {
            const Icon = icons[feature.icon];
            return (
              <div key={feature.titleKey} className="rounded-3xl border border-white/10 bg-white/[0.03] p-5">
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-neon-green/20 bg-neon-green/10 text-neon-green">
                  <Icon className="h-5 w-5" />
                </div>
                <h3 className="mt-4 text-base font-semibold text-white">{translate(feature.titleKey)}</h3>
                <p className="mt-2 text-sm leading-6 text-white/45">{translate(feature.textKey)}</p>
              </div>
            );
          })}
        </section>

        <section className="mb-10 rounded-[2rem] border border-white/10 bg-[linear-gradient(135deg,rgba(16,185,129,0.12),rgba(139,92,246,0.08))] p-8 text-center sm:p-10">
          <h2 className="text-2xl font-bold text-white sm:text-3xl">{translate(landingDesign.cta.titleKey)}</h2>
          <p className="mx-auto mt-3 max-w-lg text-sm leading-6 text-white/55">{translate(landingDesign.cta.subtitleKey)}</p>
          <p className="mt-6 text-sm font-semibold text-white/80">{translate(landingDesign.cta.buttonKey)}</p>
        </section>

        <footer className="flex flex-col gap-3 border-t border-white/10 py-5 text-sm text-white/40 sm:flex-row sm:items-center sm:justify-between">
          <p>{t("landing.footer.copy", { year: new Date().getFullYear() })}</p>
        </footer>
      </div>
    </div>
  );
}
