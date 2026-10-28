import AdminCollectorTabs from "@/components/AdminCollectorTabs";
import TGInviteWorkspace from "@/components/tginvite/TGInviteClient";

export const metadata = {
  title: "TG Invite | POTAPoff Admin",
  description: "TG Invite в разделе администрирования.",
};

export default function TGInviteAdminPage() {
  return (
    <div className="w-full max-w-[1480px] mx-auto space-y-6 py-6 px-4">
      <header className="surface-panel-hero rounded-2xl border border-bg-border p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-content-muted">Administration</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-content">Управление TG Invite</h1>
        <p className="mt-2 text-sm text-content-muted">Исходное рабочее пространство с действующими API и проверкой пользователя.</p>
      </header>
      <AdminCollectorTabs />
      <TGInviteWorkspace />
    </div>
  );
}
