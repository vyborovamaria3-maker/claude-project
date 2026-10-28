import AdminCollectorTabs from "@/components/AdminCollectorTabs";
import XCollectorTab from "@/app/settings/XCollectorTab";

export const metadata = {
  title: "X Collector | POTAPoff Admin",
  description: "Управление X Collector в разделе администрирования.",
};

export default function XCollectorAdminPage() {
  return (
    <div className="w-full max-w-[1480px] mx-auto space-y-6 py-6 px-4">
      <header className="surface-panel-hero rounded-2xl border border-bg-border p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-content-muted">Administration</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-content">Управление X Collector</h1>
        <p className="mt-2 text-sm text-content-muted">Все существующие функции сборщика и публикации без переноса сессий или базы данных.</p>
      </header>
      <AdminCollectorTabs />
      <XCollectorTab />
    </div>
  );
}
