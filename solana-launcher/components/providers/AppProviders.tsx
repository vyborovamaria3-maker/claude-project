"use client";

import { useEffect, useState } from "react";
import { HeroUIProvider } from "@heroui/react";
import { resolveSupportedLocale, SOURCE_LOCALE } from "@/lib/i18n/locales";
import { QueryClientProvider } from "@/lib/react-query";
import { createAppQueryClient } from "@/lib/queryClient";
import { I18nProvider } from "@/components/providers/I18nProvider";
import EncodingRepair from "@/components/providers/EncodingRepair";
import ThemeRuntime from "@/components/providers/ThemeRuntime";

export default function AppProviders({
  children,
  initialLocale = SOURCE_LOCALE,
}: {
  children: React.ReactNode;
  initialLocale?: string;
}) {
  const [queryClient] = useState(() => createAppQueryClient());
  const [locale] = useState(() => resolveSupportedLocale(initialLocale));

  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;

    const register = async () => {
      try {
        const registration = await navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
        await registration.update();
      } catch (error) {
        console.warn("Service worker registration failed", error);
      }
    };

    if (document.readyState === "complete") {
      void register();
      return;
    }

    const onLoad = () => void register();
    window.addEventListener("load", onLoad, { once: true });
    return () => window.removeEventListener("load", onLoad);
  }, []);

  return (
    <I18nProvider initialLocale={locale}>
      <HeroUIProvider>
        <QueryClientProvider client={queryClient}>
          <ThemeRuntime />
          <EncodingRepair />
          {children}
        </QueryClientProvider>
      </HeroUIProvider>
    </I18nProvider>
  );
}
