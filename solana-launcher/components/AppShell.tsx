"use client";

import { usePathname } from "next/navigation";
import { useMemo } from "react";
import SidebarTop from "@/components/SidebarTop";
import MasterWalletBar from "@/components/MasterWalletBar";
import SidebarNav from "@/components/SidebarNav";
import Header from "@/components/Header";
import TrendingBar from "@/components/TrendingBar";
import DesktopOnlyOverlays from "@/components/DesktopOnlyOverlays";
import ThemePickerToggle from "@/components/ThemePickerToggle";
import { siteDesign } from "@/lib/siteDesign";

const PUBLIC_ROUTES = new Set(siteDesign.publicRoutes);

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isPublic = useMemo(() => PUBLIC_ROUTES.has(pathname), [pathname]);

  if (isPublic) {
    return (
      <main className={siteDesign.shell.publicMainClassName}>
        <div className={siteDesign.shell.publicBackgroundClassName} />
        {children}
      </main>
    );
  }

  return (
    <>
      <div className={siteDesign.shell.sidebarClassName} style={{ width: "16rem" }}>
        <SidebarTop />
        <MasterWalletBar />
        <SidebarNav />
      </div>
      <div
        className={siteDesign.shell.contentClassName}
        style={{ marginLeft: "16rem", width: "calc(100vw - 16rem)" }}
      >
        <div className={siteDesign.shell.appBackgroundClassName} />
        <Header />
        <TrendingBar />
        <main className={siteDesign.shell.mainClassName}>{children}</main>
      </div>
      <DesktopOnlyOverlays />
      <ThemePickerToggle />
    </>
  );
}
