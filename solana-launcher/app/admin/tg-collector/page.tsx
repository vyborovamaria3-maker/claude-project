import TGCollectorTab from "@/app/settings/TGCollectorTab";
import AdminCollectorTabs from "@/components/AdminCollectorTabs";

export default function TgCollectorAdminPage() {
  return (
    <div className="w-full max-w-[1480px] mx-auto space-y-6 py-6 px-4">
      <section className="surface-panel-hero relative overflow-hidden rounded-2xl border border-bg-border p-6">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-content-muted">Administration</div>
            <h1 className="mt-1 text-2xl font-bold tracking-tight text-content sm:text-3xl">Collector Control Center</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-content-muted">
              Единое управление X Collector и Telegram Collector. TG Collector использует тот же рабочий компонент,
              чтобы настройки и операционные действия не расходились между пользовательской панелью и админкой.
            </p>
          </div>
        </div>
      </section>
      <AdminCollectorTabs />
      <TGCollectorTab />
    </div>
  );
}
