import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";
import "@solana/wallet-adapter-react-ui/styles.css";
import { AppProviders } from "../components/AppProviders";

function isLocalhostHost(host: string) {
  return host.includes("localhost") || host.includes("127.0.0.1") || host.includes("[::1]");
}

export async function generateMetadata(): Promise<Metadata> {
  const host = headers().get("host") ?? "";

  return {
    title: "SolSub",
    description: "Solana subscription dashboard with Telegram login and wallet payments.",
    manifest: isLocalhostHost(host) ? undefined : "/manifest.json"
  };
}

export const viewport: Viewport = {
  themeColor: "#2fbf8f",
  width: "device-width",
  initialScale: 1
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
