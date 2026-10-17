import TGCollectorTab from "@/app/settings/TGCollectorTab";
import { notFound } from "next/navigation";

export const metadata = {
  title: "TG Collector | POTAPoff",
  description: "Локальный сбор Telegram-каналов, очередь задач и поиск по истории.",
};

export default function TGCollectorPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <div className="mx-auto w-full max-w-[1480px] space-y-6 py-6 sm:py-8" data-tag="page.tg_collector">
      <TGCollectorTab />
    </div>
  );
}
