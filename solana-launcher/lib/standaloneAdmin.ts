import { notFound, redirect } from "next/navigation";

export type CollectorModule = "x-collector" | "tg-collector" | "tg-invite";

/** Only server configuration can choose the separate administration origin. */
export function standaloneAdminUrl(module?: CollectorModule): string | null {
  const configured = process.env.ADMIN_SITE_URL;
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null;
    return new URL(module ? `/collectors/${module}` : "/", url).toString();
  } catch { return null; }
}

export function redirectToStandaloneAdmin(module?: CollectorModule): never {
  const target = standaloneAdminUrl(module);
  if (!target) notFound();
  redirect(target);
}
