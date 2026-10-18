"use client";

import Link from "next/link";
import { Database, Twitter } from "lucide-react";
import { usePathname } from "next/navigation";

export default function AdminCollectorTabs() {
  const pathname = usePathname();
  const items = [
    { href: "/admin/twitter-registry", label: "X Collector", icon: Twitter },
    { href: "/admin/tg-collector", label: "TG Collector", icon: Database },
  ];
  return (
    <nav aria-label="Collector administration" className="flex flex-wrap gap-2 rounded-2xl border border-bg-border bg-bg-card/60 p-2">
      {items.map(({ href, label, icon: Icon }) => {
        const active = pathname === href || pathname.startsWith(href + "/");
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={[
              "inline-flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-semibold transition",
              active
                ? "border-primary-border bg-primary-soft text-primary"
                : "border-transparent text-content-muted hover:border-bg-border hover:bg-bg-elevated hover:text-content",
            ].join(" ")}
          >
            <Icon className="h-4 w-4" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
