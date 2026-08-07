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
    "inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl border border-neon-green/30 bg-neon-green/15 px-5 py-3 text-center text-sm font-semibold text-neon-green transition hover:border-neon-green/50 hover:bg-neon-green/20 sm:w-auto sm:px-6 sm:py-3.5",
  ghost:
    "inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl border border-white/12 px-5 py-3 text-center text-sm font-semibold text-white transition hover:border-white/20 hover:bg-white/[0.03] sm:w-auto sm:px-6 sm:py-3.5",
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
      <span className="min-w-0 break-words">{label}</span>
      {Icon ? <Icon className="h-4 w-4 shrink-0" /> : null}
    </Link>
  );
}

export default function PublicLandingPage() {
  const { t } = useI18n();
  const translate = (key: string) => t(key as Parameters<typeof t>[0]);
  const BrandIcon = icons[landingDesign.header.brandIcon];
  const BadgeIcon = icons[landingDesign.hero.badgeIcon];

  return (
    <div className={`${landingDesign.shell.pageClassName} min-w-0`}>
      <div className={`${landingDesign.shell.containerClassName} min-w-0 px-3 py-3 sm:px-6 sm:py-5 lg:px-10 lg:py-6`}>
        <header className="flex min-w-0 flex-col gap-4 rounded-2xl border border-white/10 bg-black/20 px-4 py-4 backdrop-blur-xl sm:flex-row sm:items-center sm:justify-between sm:rounded-3xl sm:px-5">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-white/45 sm:text-xs sm:tracking-[0.3em]">
              <BrandIcon className="h-3.5 w-3.5 shrink-0 text-neon-green" />
              <span className="min-w-0 break-words">{translate(landingDesign.header.brandKey)}</span>
            </div>
            <p className="mt-1 break-words text-xs leading-5 text-white/45 sm:text-sm">{translate(landingDesign.header.subtitleKey)}</p>
          </div>
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
            <div className="self-start sm:self-auto">
              <LanguageSwitcher />
            </div>
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

        <main className="grid min-w-0 flex-1 items-center gap-8 py-9 sm:gap-10 sm:py-12 lg:grid-cols-[1.05fr_0.95fr] lg:gap-12 lg:py-16">
          <section className="min-w-0 max-w-2xl">
            <div className="inline-flex max-w-full items-center gap-2 rounded-full border border-neon-green/25 bg-neon-green/10 px-3 py-2 text-[11px] font-semibold text-neon-green sm:px-4 sm:text-xs">
              <BadgeIcon className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 break-words">{translate(landingDesign.hero.badgeKey)}</span>
            </div>

            <h1 className="mt-5 break-words text-3xl font-black leading-[1.05] text-white sm:mt-6 sm:text-5xl lg:text-6xl">
              {translate(landingDesign.hero.titleKey)}
            </h1>

            <p className="mt-4 max-w-xl break-words text-sm leading-6 text-white/55 sm:mt-5 sm:text-lg sm:leading-7">
              {translate(landingDesign.hero.subtitleKey)}
            </p>

            <div className="mt-7 flex min-w-0 flex-col gap-3 sm:mt-8 sm:flex-row sm:flex-wrap">
              {landingDesign.hero.actions.map((action) => (
                <ActionLink key={action.href} href={action.href} label={translate(action.labelKey)} tone={action.tone} />
              ))}
            </div>

            <div className="mt-7 flex min-w-0 flex-wrap items-center gap-2.5 sm:mt-8 sm:gap-4">
              {landingDesign.trustBadges.map((badge) => {
                const Icon = icons[badge.icon];
                return (
                  <div
                    key={badge.labelKey}
                    className="flex max-w-full items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[11px] text-white/60 sm:text-xs"
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0 text-neon-green" />
                    <span className="min-w-0 break-words">{translate(badge.labelKey)}</span>
                  </div>
                );
              })}
            </div>

            <div className="mt-8 grid min-w-0 grid-cols-1 gap-3 sm:mt-10 sm:grid-cols-3 sm:gap-4">
              {landingDesign.metrics.map((metric) => (
                <div key={metric.labelKey} className="min-w-0 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                  <div className="break-words text-2xl font-bold text-white sm:text-3xl">{metric.value}</div>
                  <div className="mt-1 break-words text-[10px] uppercase tracking-[0.16em] text-white/40 sm:text-xs sm:tracking-[0.2em]">
                    {translate(metric.labelKey)}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="relative min-w-0">
            <div className={landingDesign.visual.outerGlowClassName} />
            <div className={`${landingDesign.visual.frameClassName} min-w-0 p-2.5 sm:p-6`}>
              <div className={`${landingDesign.visual.stageClassName} min-h-[340px] min-w-0 p-4 sm:min-h-[460px] sm:p-6`}>
                <div className="pointer-events-none absolute inset-0">
                  <Strands className="absolute inset-0 opacity-100" {...landingDesign.visual.strandProps} />
                </div>
                <div className={landingDesign.visual.overlayClassName} />
                <div className="absolute inset-0 bg-[linear-gradient(135deg,rgba(255,255,255,0.08),transparent_26%,transparent_74%,rgba(255,255,255,0.07))]" />
                <div className="relative min-w-0">
                  <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="break-words text-[10px] uppercase tracking-[0.22em] text-white/55 sm:text-xs sm:tracking-[0.3em]">
                        {translate(landingDesign.visual.kickerKey)}
                      </p>
                      <h2 className="mt-2 break-words text-lg font-bold text-white sm:text-xl">{translate(landingDesign.visual.titleKey)}</h2>
                    </div>
                    <div className="w-fit max-w-full rounded-full border border-fuchsia-200/40 bg-fuchsia-300/20 px-3 py-1 text-xs font-semibold text-fuchsia-50 shadow-[0_0_28px_rgba(232,121,249,0.35)]">
                      {landingDesign.visual.badge}
                    </div>
                  </div>

                  <div className="mt-5 grid min-h-[230px] min-w-0 items-end gap-3 sm:mt-6 sm:min-h-[350px]">
                    <div className="min-w-0 rounded-[1.2rem] border border-white/14 bg-black/36 p-3 shadow-[0_0_0_1px_rgba(255,255,255,0.02),0_0_50px_rgba(139,92,246,0.18)] backdrop-blur-md sm:rounded-[1.4rem] sm:p-4">
                      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                        <div className="min-w-0 break-words text-[10px] uppercase tracking-[0.2em] text-white/55 sm:text-xs sm:tracking-[0.28em]">
                          {landingDesign.visual.panelLabel}
                        </div>
                        <div className="w-fit max-w-full rounded-full border border-neon-green/35 bg-neon-green/20 px-3 py-1 text-xs font-semibold text-neon-green shadow-[0_0_22px_rgba(34,197,94,0.2)]">
                          {translate(landingDesign.visual.statusKey)}
                        </div>
                      </div>
                      <p className="mt-3 break-words text-xs leading-5 text-white/92 sm:text-sm sm:leading-6">{landingDesign.visual.body}</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </main>

        <section className="min-w-0 pb-8 sm:pb-10">
          <div className="mb-6 text-center sm:mb-8">
            <h2 className="break-words text-xl font-bold text-white sm:text-3xl">{t("landing.howItWorksTitle")}</h2>
            <p className="mt-2 break-words text-sm leading-6 text-white/50">{t("landing.howItWorksSubtitle")}</p>
          </div>
          <div className="grid min-w-0 gap-4 sm:grid-cols-3">
            {landingDesign.steps.map((step) => {
              const Icon = icons[step.icon];
              return (
                <div key={step.num} className="relative min-w-0 rounded-2xl border border-white/10 bg-white/[0.03] p-5 sm:rounded-3xl sm:p-6">
                  <div className="text-[10px] font-black uppercase tracking-[0.3em] text-neon-green">{step.num}</div>
                  <div className="mt-4 flex h-11 w-11 items-center justify-center rounded-2xl border border-neon-green/20 bg-neon-green/10 text-neon-green">
                    <Icon className="h-5 w-5" />
                  </div>
                  <h3 className="mt-4 break-words text-base font-semibold text-white">{translate(step.titleKey)}</h3>
                  <p className="mt-2 break-words text-sm leading-6 text-white/45">{translate(step.descKey)}</p>
                </div>
              );
            })}
          </div>
        </section>

        <section id="features" className="grid min-w-0 gap-4 pb-8 sm:grid-cols-2 sm:pb-10 xl:grid-cols-4">
          {landingDesign.features.map((feature) => {
            const Icon = icons[feature.icon];
            return (
              <div key={feature.titleKey} className="min-w-0 rounded-2xl border border-white/10 bg-white/[0.03] p-5 sm:rounded-3xl">
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-neon-green/20 bg-neon-green/10 text-neon-green">
                  <Icon className="h-5 w-5" />
                </div>
                <h3 className="mt-4 break-words text-base font-semibold text-white">{translate(feature.titleKey)}</h3>
                <p className="mt-2 break-words text-sm leading-6 text-white/45">{translate(feature.textKey)}</p>
              </div>
            );
          })}
        </section>

        <section className="mb-8 min-w-0 rounded-2xl border border-white/10 bg-[linear-gradient(135deg,rgba(16,185,129,0.12),rgba(139,92,246,0.08))] p-5 text-center sm:mb-10 sm:rounded-[2rem] sm:p-10">
          <h2 className="break-words text-xl font-bold text-white sm:text-3xl">{translate(landingDesign.cta.titleKey)}</h2>
          <p className="mx-auto mt-3 max-w-lg break-words text-sm leading-6 text-white/55">{translate(landingDesign.cta.subtitleKey)}</p>
          <p className="mt-5 break-words text-sm font-semibold text-white/80 sm:mt-6">{translate(landingDesign.cta.buttonKey)}</p>
        </section>

        <footer className="flex min-w-0 flex-col gap-3 border-t border-white/10 py-5 text-sm text-white/40 sm:flex-row sm:items-center sm:justify-between">
          <p className="break-words">{t("landing.footer.copy", { year: new Date().getFullYear() })}</p>
        </footer>
      </div>
    </div>
  );
}
