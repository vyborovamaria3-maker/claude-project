import { redirect } from "next/navigation";
import { notFound } from "next/navigation";

export const metadata = {
  title: "TG Collector | POTAPoff",
  description: "Локальный сбор Telegram-каналов, очередь задач и поиск по истории.",
};

export default function TGCollectorPage() {
  if (process.env.NODE_ENV === "production") notFound();
  redirect("/admin/tg-collector");
}
