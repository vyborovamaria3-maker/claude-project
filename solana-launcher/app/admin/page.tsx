import Link from "next/link";
import { Database, Twitter, UserPlus, ListTree } from "lucide-react";

export const metadata = {
  title: "Administration | POTAPoff",
  description: "Управление сборщиками и TG Invite.",
};

const modules = [
  { href: "/admin/x-collector", title: "X Collector", description: "Сбор X, очереди, аккаунты, публикация и мониторинг.", icon: Twitter },
  { href: "/admin/tg-collector", title: "TG Collector", description: "Сбор Telegram, история, источники и аналитика.", icon: Database },
  { href: "/admin/tg-invite", title: "TG Invite", description: "TG Invite, источники, операции и настройки.", icon: UserPlus },
  { href: "/admin/twitter-registry", title: "X Registry", description: "Реестр и проверка X-аккаунтов.", icon: ListTree },
] as const;

export default function AdminHomePage() {
  return (
    <div className="w-full max-w-[1480px] mx-auto space-y-6 py-6 px-4">
      <header className="surface-panel-hero rounded-2xl border border-bg-border p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-content-muted">Administration</p>
        <h1 className="mt-1 text-2xl font-bold text-content">Админка</h1>
        <p className="mt-2 text-sm text-content-muted">Управление сервисами без дублирования их API и хранилищ.</p>
      </header>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {modules.map(({ href, title, description, icon: Icon }) => (
          <Link key={href} href={href} className="surface-panel rounded-2xl border border-bg-border p-5 hover:border-primary-border">
            <div className="flex items-center gap-3 text-content"><Icon className="h-5 w-5 text-primary" /><h2 className="text-lg font-semibold">{title}</h2></div>
            <p className="mt-3 text-sm text-content-muted">{description}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
