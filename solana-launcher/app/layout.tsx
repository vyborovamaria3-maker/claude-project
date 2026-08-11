import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { JetBrains_Mono, Manrope } from "next/font/google";
import "./globals.css";
import "./adaptive-theme.css";
import "./responsive.css";
import "./landing-responsive.css";
import AppShell from "@/components/AppShell";
import AppProviders from "@/components/providers/AppProviders";
import { isRtlLocale, LOCALE_COOKIE_NAME, resolveSupportedLocale } from "@/lib/i18n/locales";

const manrope = Manrope({
  subsets: ["latin", "cyrillic"],
  variable: "--font-inter",
  display: "swap",
});

const jetBrainsMono = JetBrains_Mono({
  subsets: ["latin", "cyrillic"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "POTAPoff - Solana Launch Platform",
  description: "Futuristic Solana token launch and trading dashboard",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const cookieStore = await cookies();
  const initialLocale = resolveSupportedLocale(cookieStore.get(LOCALE_COOKIE_NAME)?.value);

  return (
    <html lang={initialLocale} dir={isRtlLocale(initialLocale) ? "rtl" : "ltr"} data-theme="dark">
      <body
        data-tag="main theme"
        className={`${manrope.variable} ${jetBrainsMono.variable} min-h-screen bg-bg text-content grid-bg antialiased`}
      >
        <AppProviders initialLocale={initialLocale}>
          <AppShell>{children}</AppShell>
        </AppProviders>
      </body>
    </html>
  );
}
