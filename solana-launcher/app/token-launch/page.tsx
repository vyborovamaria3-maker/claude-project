"use client";

import Link from "next/link";
import { Rocket, Users } from "lucide-react";
import { useI18n } from "@/components/providers/I18nProvider";

// data-tag: page.token_launch
export default function TokenLaunchPage() {
  const { t } = useI18n();

  return (
    <div data-tag="page.token_launch" className="w-full max-w-[1480px] mx-auto px-0 sm:px-4 py-6 sm:py-8 space-y-6">
      <section className="surface-panel-hero relative overflow-hidden px-5 py-6 sm:px-6 sm:py-7 text-center">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(20,241,149,0.12),transparent_28%),radial-gradient(circle_at_top_right,rgba(245,166,28,0.10),transparent_28%),radial-gradient(circle_at_bottom_right,rgba(29,155,240,0.08),transparent_30%)]" />
        <div className="relative">
          <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-content-muted">
            <Rocket className="h-3.5 w-3.5 text-primary" />
            Launch modes
          </div>
          <h1 className="mt-4 text-3xl md:text-4xl font-bold text-content">{t("tokenLaunch.title")}</h1>
          <p className="mt-2 text-sm md:text-base text-content-muted">{t("tokenLaunch.subtitle")}</p>
        </div>
      </section>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5 xl:gap-6">
        <ModeCard
          tag="token_launch.mode.new_bundle"
          href="/token-launch/new"
          icon={<Rocket className="w-7 h-7" />}
          title={t("tokenLaunch.newBundle.title")}
          description={t("tokenLaunch.newBundle.description")}
        />
        <ModeCard
          tag="token_launch.mode.cto"
          href="/token-launch/cto"
          icon={<Users className="w-7 h-7" />}
          title={t("tokenLaunch.cto.title")}
          description={t("tokenLaunch.cto.description")}
        />
      </div>
    </div>
  );
}

function ModeCard({
  tag,
  href,
  icon,
  title,
  description,
}: {
  tag: string;
  href: string;
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <Link
      href={href}
      data-tag={tag}
      className="group surface-panel-hero relative overflow-hidden rounded-2xl p-8 md:p-12 flex flex-col items-center text-center min-h-[300px] justify-center transition hover:-translate-y-0.5"
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.08),transparent_40%)]" />
      <div className="relative w-16 h-16 rounded-full bg-primary-soft border border-primary-border flex items-center justify-center text-primary mb-5 group-hover:bg-primary-soft transition">
        {icon}
      </div>
      <h2 className="relative text-xl md:text-2xl font-semibold text-content">{title}</h2>
      <p className="relative text-sm text-content-muted mt-2 max-w-xs">{description}</p>
    </Link>
  );
}
