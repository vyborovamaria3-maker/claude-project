import { headers } from "next/headers";
import { DashboardPageClient } from "../../components/DashboardPageClient";

function isLocalhostHost(host: string) {
  return host.includes("localhost") || host.includes("127.0.0.1") || host.includes("[::1]");
}

export default function DashboardPage() {
  const host = headers().get("host") ?? "";
  return <DashboardPageClient isLocalDev={isLocalhostHost(host)} />;
}
