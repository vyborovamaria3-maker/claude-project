import type { Metadata, Viewport } from "next";
import PublicLandingPage from "@/components/PublicLandingPage";

export const metadata: Metadata = {
  title: "POTAPoff — Solana Launch & Market Intelligence",
  description:
    "Запуск токенов, анализ кошельков, bundle intelligence и реальный контекст рынка Solana в одной профессиональной рабочей среде.",
  applicationName: "POTAPoff",
  keywords: ["Solana", "token launch", "wallet intelligence", "market intelligence", "bundle analysis"],
  openGraph: {
    title: "POTAPoff — Solana Launch & Market Intelligence",
    description:
      "Запуск токенов, анализ кошельков и реальный контекст рынка Solana в одной рабочей среде.",
    type: "website",
    siteName: "POTAPoff",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
  viewportFit: "cover",
};

export default function HomePage() {
  return <PublicLandingPage />;
}
